// =========================================================================
// NOTION SYNC PLUGIN (Side Panel Edition)
// =========================================================================

let config = {};

// Load config safely from host storage
function loadConfigSync() {
  try {
    const stored = localStorage.getItem('notion_sync_config');
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    return {};
  }
}

// Initial load
config = loadConfigSync();

let iframeSource = null;
let iframeOrigin = '*';

function sendLog(msg) {
  if (iframeSource) {
    try {
      iframeSource.postMessage({ type: 'NOTION_HOST_LOG', message: msg }, iframeOrigin);
    } catch(e) {}
  }
}

// Load config safely from host storage
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'NOTION_SAVE_CONFIG') {
    config = event.data.config;
    localStorage.setItem('notion_sync_config', JSON.stringify(config));
  } else if (event.data && event.data.type === 'NOTION_GET_CONFIG') {
    if (event.source) {
      iframeSource = event.source;
      iframeOrigin = event.origin || '*';
      (async () => {
        let spProjects = [];
        let hostLogs = [];
        try {
          if (typeof PluginAPI !== 'undefined') {
            let rawProjects = [];
            if (PluginAPI.getAllProjects) {
              rawProjects = await PluginAPI.getAllProjects();
            } else if (PluginAPI.getAppState) {
              const state = await PluginAPI.getAppState();
              if (state && state.project && state.project.entities) {
                rawProjects = Object.values(state.project.entities);
              }
            }
            if (rawProjects && Array.isArray(rawProjects)) {
              spProjects = rawProjects.map(p => ({ id: p.id, title: p.title }));
            }
          }
        } catch (e) { 
          hostLogs.push('Error fetching SP projects in host: ' + e.message); 
        }
        
        event.source.postMessage({ 
          type: 'NOTION_CONFIG_DATA', 
          config: config, 
          spProjects: spProjects,
          hostLogs: hostLogs
        }, '*');
      })();
    }
  }
});

async function getPluginConfig() {
  return config;
}

// --- ID Encoding Helpers ---
const ZW_PREFIX = '\u200D\u200D\u200D';
const ZW_SUFFIX = '\u200D\u200D\u200D';

function encodeId(idStr) {
  return Array.from(idStr).map(c => 
    c.charCodeAt(0).toString(2).padStart(8, '0').split('').map(b => b === '1' ? '\u200C' : '\u200B').join('')
  ).join('');
}

function decodeId(encodedStr) {
  const binary = Array.from(encodedStr).map(c => c === '\u200C' ? '1' : '0').join('');
  let str = '';
  for (let i = 0; i < binary.length; i += 8) {
    str += String.fromCharCode(parseInt(binary.slice(i, i+8), 2));
  }
  return str;
}

function embedId(title, idStr) {
  return title + ZW_PREFIX + encodeId(idStr) + ZW_SUFFIX;
}

function extractId(title) {
  if (!title) return null;
  const match = title.match(new RegExp(ZW_PREFIX + '([\\u200B\\u200C]+)' + ZW_SUFFIX));
  if (match) return decodeId(match[1]);
  return null;
}

// --- Notion API Helper ---
async function notionApi(endpoint, method, body, token) {
  const url = `https://api.notion.com/v1${endpoint}`;
  const res = await fetch(url, {
    method: method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    throw new Error(`Notion API Error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Sync Logic ---
let isSyncing = false;

const delay = ms => new Promise(r => setTimeout(r, ms));

function notionBlocksToMarkdown(blocks) {
  let bodyMd = '';
  for (const block of blocks) {
    if (block.type === 'paragraph' && block.paragraph.rich_text.length) {
      bodyMd += block.paragraph.rich_text.map(t => t.plain_text).join('') + '\n\n';
    } else if (block.type.startsWith('heading_')) {
      const level = parseInt(block.type.split('_')[1]);
      bodyMd += '#'.repeat(level) + ' ' + block[block.type].rich_text.map(t => t.plain_text).join('') + '\n\n';
    } else if (block.type === 'bulleted_list_item') {
      bodyMd += '- ' + block.bulleted_list_item.rich_text.map(t => t.plain_text).join('') + '\n';
    } else if (block.type === 'numbered_list_item') {
      bodyMd += '1. ' + block.numbered_list_item.rich_text.map(t => t.plain_text).join('') + '\n';
    } else if (block.type === 'to_do') {
      bodyMd += (block.to_do.checked ? '- [x] ' : '- [ ] ') + block.to_do.rich_text.map(t => t.plain_text).join('') + '\n';
    }
  }
  return bodyMd.trim();
}

async function runSync() {
  if (isSyncing) {
    sendLog('runSync skipped: already syncing');
    return;
  }
  isSyncing = true;
  sendLog('runSync started');

  try {
    const currentConfig = await getPluginConfig();
    const token = currentConfig.notionToken;
    
    if (!token) {
      sendLog('No token found, aborting sync');
      isSyncing = false;
      return;
    }
    
    const mappings = currentConfig.mappings || [];
    if (mappings.length === 0) {
      sendLog('No mappings found, aborting sync');
      isSyncing = false;
      return;
    }

    sendLog(`Fetching SP tasks...`);
    const spTasks = await PluginAPI.getTasks();
    sendLog(`Fetched ${spTasks.length} SP tasks`);
    
    let importedCount = 0;
    let completedCount = 0;
    let resolvedOfflineCount = 0;
    let totalPushedCount = 0;
    
    for (let i = 0; i < mappings.length; i++) {
      try {
        const mapping = mappings[i];
        sendLog(`Processing mapping ${i + 1}/${mappings.length}...`);
        if (!mapping.notionDbId || !mapping.spProjectId) continue;
        
        const statusProp = mapping.statusProperty || 'Status';
        const importStatuses = mapping.importStatuses && mapping.importStatuses.length > 0 
          ? mapping.importStatuses 
          : (mapping.importStatus ? [mapping.importStatus] : ['Not started']);
        const completeStatus = mapping.completeStatus || 'Done';

        if (importStatuses.length === 0) {
          sendLog(`Skipping mapping ${i + 1}: no importStatuses`);
          continue;
        }

        // 1. Fetch active tasks from Notion
        let items = [];
        let hasMore = true;
        let nextCursor = undefined;

        sendLog(`Querying Notion for mapping ${i + 1} with ${importStatuses.length} statuses...`);
        while (hasMore) {
          const orConditions = [];
          importStatuses.forEach(status => {
            if (status === '__EMPTY__') {
              if (mapping.statusPropertyType === 'select') {
                orConditions.push({ property: statusProp, select: { is_empty: true } });
              } else {
                orConditions.push({ property: statusProp, status: { is_empty: true } });
              }
            } else {
              if (mapping.statusPropertyType === 'select') {
                orConditions.push({ property: statusProp, select: { equals: status } });
              } else {
                orConditions.push({ property: statusProp, status: { equals: status } });
              }
            }
          });

          const filterBody = {
            filter: {
              or: orConditions
            },
            start_cursor: nextCursor
          };

          sendLog(`Executing Notion API search query (cursor: ${nextCursor || 'first'})...`);
          const data = await notionApi(`/databases/${mapping.notionDbId}/query`, 'POST', filterBody, token);
          if (data.results) items = items.concat(data.results);
          hasMore = data.has_more;
          nextCursor = data.next_cursor;
        }
        sendLog(`Fetched ${items.length} active items from Notion for mapping ${i + 1}`);

        // 2. Import new tasks
        for (const item of items) {
          const issueIdStr = `notion_${mapping.notionDbId}_${item.id}`;
          const exists = spTasks.find(t => 
             (t.issueId === issueIdStr) || 
             (extractId(t.title) === issueIdStr)
          );

          if (!exists) {
            let pageTitle = 'Untitled';
            for (const key in item.properties) {
              if (item.properties[key].type === 'title') {
                const titleArr = item.properties[key].title;
                if (titleArr && titleArr.length > 0) {
                  pageTitle = titleArr.map(t => t.plain_text).join('');
                }
                break;
              }
            }

            let taskNotes = `[Open in Notion](${item.url})`;
            
            if (mapping.notesMapping) {
              if (mapping.notesMapping === '__PAGE_BODY__') {
                sendLog(`Fetching page blocks for item ${item.id}...`);
                try {
                  const blockData = await notionApi(`/blocks/${item.id}/children?page_size=100`, 'GET', null, token);
                  sendLog(`Retrieved blocks: ${blockData?.results?.length || 0} items. Raw: ${JSON.stringify(blockData).substring(0, 150)}`);
                  if (blockData && blockData.results) {
                    const md = notionBlocksToMarkdown(blockData.results);
                    sendLog(`Parsed markdown length: ${md.length} characters`);
                    if (md) taskNotes += `\n\n---\n\n${md}`;
                  }
                  await delay(350); // Rate limit protection
                } catch(err) {
                  sendLog(`Failed to fetch blocks for ${item.id}: ${err.message}`);
                }
              } else {
                const prop = item.properties[mapping.notesMapping];
                if (prop) {
                  let propText = '';
                  if (prop.rich_text) propText = prop.rich_text.map(t => t.plain_text).join('');
                  else if (prop.title) propText = prop.title.map(t => t.plain_text).join('');
                  else if (prop.select) propText = prop.select.name;
                  else if (prop.multi_select) propText = prop.multi_select.map(s => s.name).join(', ');
                  
                  if (propText) taskNotes += `\n\n---\n\n**${mapping.notesMapping}:**\n${propText}`;
                }
              }
            }

            try {
              await PluginAPI.addTask({
                title: embedId(pageTitle, issueIdStr),
                projectId: mapping.spProjectId,
                notes: taskNotes
              });
              importedCount++;
            } catch(e) {
              console.error('Failed to add SP task', e);
            }
          }
        }

        // 3. Mark tasks complete in SP if they were completed in Notion
        // 4. Offline Resolution: Mark tasks complete in Notion if they are done in SP but Notion still has them active
        for (const t of spTasks) {
          if (!t.isDone) {
            const tIssueId = extractId(t.title);
            if (tIssueId && tIssueId.startsWith(`notion_${mapping.notionDbId}_`)) {
              const stillActive = items.find(item => `notion_${mapping.notionDbId}_${item.id}` === tIssueId);
              if (!stillActive) {
                try {
                  let shouldDelete = false;
                  if (mapping.deleteStatus) {
                    const pageId = tIssueId.split('_')[2];
                    const page = await notionApi(`/pages/${pageId}`, 'GET', null, token);
                    await delay(350); // Rate limit protection
                    const propData = page.properties[statusProp];
                    if (propData) {
                      let currentStatus = '';
                      if (propData.type === 'status' && propData.status) currentStatus = propData.status.name;
                      else if (propData.type === 'select' && propData.select) currentStatus = propData.select.name;
                      
                      if (currentStatus === mapping.deleteStatus) {
                        shouldDelete = true;
                      }
                    }
                  }
                  
                  if (shouldDelete) {
                    await PluginAPI.deleteTask(t.id);
                    PluginAPI.showSnack({ msg: `Task deleted via Notion sync`, type: 'INFO' });
                  } else {
                    await PluginAPI.updateTask(t.id, { isDone: true });
                    PluginAPI.showSnack({ msg: `Task completed via Notion sync`, type: 'SUCCESS' });
                    completedCount++;
                  }
                } catch(e) {
                  console.error('Failed to complete/delete SP task', e);
                }
              }
            }
          } else {
            const tIssueId = extractId(t.title);
            if (tIssueId && tIssueId.startsWith(`notion_${mapping.notionDbId}_`)) {
              const activeInNotion = items.find(item => `notion_${mapping.notionDbId}_${item.id}` === tIssueId);
              if (activeInNotion) {
                const pageId = activeInNotion.id;
                const propData = activeInNotion.properties[statusProp];
                if (propData) {
                  const updateBody = { properties: {} };
                  if (propData.type === 'status') {
                    updateBody.properties[statusProp] = { status: { name: completeStatus } };
                  } else if (propData.type === 'select') {
                    updateBody.properties[statusProp] = { select: { name: completeStatus } };
                  }
                  
                  try {
                    await notionApi(`/pages/${pageId}`, 'PATCH', updateBody, token);
                    resolvedOfflineCount++;
                  } catch(e) {
                    console.error('Failed offline resolution for task', t.id, e);
                  }
                }
              }
            }
          }
        }

        // 5. Push new SP tasks to Notion
        if (mapping.pushNewTasks && mapping.defaultPushStatus) {
          const newSpTasks = spTasks.filter(t => t.projectId === mapping.spProjectId && !t.isDone && extractId(t.title) === null);
          
          if (newSpTasks.length > 0) {
            sendLog(`Found ${newSpTasks.length} new SP tasks to push to Notion.`);
            
            // Fetch DB schema to find the title property key
            let titlePropKey = 'Name';
            try {
              const dbObj = await notionApi(`/databases/${mapping.notionDbId}`, 'GET', null, token);
              for (const key in dbObj.properties) {
                if (dbObj.properties[key].type === 'title') {
                  titlePropKey = key;
                  break;
                }
              }
            } catch(err) {
              sendLog(`Failed to fetch DB schema for title key: ${err.message}`);
            }

            for (const t of newSpTasks) {
              try {
                sendLog(`Pushing task "${t.title}" to Notion...`);
                const createBody = {
                  parent: { database_id: mapping.notionDbId },
                  properties: {}
                };
                
                // Set Title
                createBody.properties[titlePropKey] = {
                  title: [{ text: { content: t.title } }]
                };
                
                // Set Status
                if (mapping.statusPropertyType === 'status') {
                  createBody.properties[statusProp] = { status: { name: mapping.defaultPushStatus } };
                } else if (mapping.statusPropertyType === 'select') {
                  createBody.properties[statusProp] = { select: { name: mapping.defaultPushStatus } };
                }
                
                // Push Notes
                if (mapping.pushNotesMapping && t.notes) {
                  const safeNotes = t.notes.substring(0, 2000);
                  if (mapping.pushNotesMapping === '__PAGE_BODY__') {
                    createBody.children = [
                      {
                        object: 'block',
                        type: 'paragraph',
                        paragraph: { rich_text: [{ type: 'text', text: { content: safeNotes } }] }
                      }
                    ];
                  } else {
                    createBody.properties[mapping.pushNotesMapping] = {
                      rich_text: [{ type: 'text', text: { content: safeNotes } }]
                    };
                  }
                }
                
                const newPage = await notionApi('/pages', 'POST', createBody, token);
                await delay(350); // Rate limit protection
                
                // Link back in SP
                const issueIdStr = `notion_${mapping.notionDbId}_${newPage.id}`;
                const newTitle = embedId(t.title, issueIdStr);
                const appendedNotes = t.notes ? t.notes + `\n\n---\n\n[Open in Notion](${newPage.url})` : `[Open in Notion](${newPage.url})`;
                
                await PluginAPI.updateTask(t.id, { title: newTitle, notes: appendedNotes });
                totalPushedCount++;
              } catch(err) {
                sendLog(`Failed to push SP task "${t.title}" to Notion: ${err.message}`);
              }
            }
          }
        }
      } catch (mappingErr) {
        sendLog(`Error processing mapping ${i + 1}: ${mappingErr.message}`);
        console.error('Mapping error', mappingErr);
      }
    }
    
    if (iframeSource) {
      try {
        iframeSource.postMessage({ 
          type: 'NOTION_SYNC_RESULT', 
          message: `Sync complete: ${importedCount} imported, ${completedCount} marked complete locally, ${resolvedOfflineCount} completed in Notion, ${totalPushedCount} pushed to Notion.` 
        }, iframeOrigin);
      } catch (err) {}
    }
  } catch (e) {
    console.error('Error during background Notion sync', e);
    sendLog(`Sync Error: ${e.message}`);
    if (iframeSource) {
      try {
        iframeSource.postMessage({ 
          type: 'NOTION_SYNC_RESULT', 
          message: `Sync failed: ${e.message}` 
        }, iframeOrigin);
      } catch (err) {}
    }
  } finally {
    isSyncing = false;
    sendLog('runSync finished');
  }
}

// Register Hooks and Timers
PluginAPI.registerHook(PluginAPI.Hooks.TASK_COMPLETE, async (payload) => {
  const currentConfig = await getPluginConfig();
  const token = currentConfig.notionToken;
  if (!token) return;

  const task = payload.task;
  if (!task) return;

  let issueIdStr = extractId(task.title);

  if (issueIdStr && issueIdStr.startsWith('notion_')) {
    const parts = issueIdStr.split('_');
    const dbId = parts[1];
    const pageId = parts[2];

    const mapping = (currentConfig.mappings || []).find(m => m.notionDbId === dbId);
    if (!mapping) return;
    
    const statusProp = mapping.statusProperty || 'Status';
    const completeStatus = mapping.completeStatus || 'Done';

    try {
      const page = await notionApi(`/pages/${pageId}`, 'GET', null, token);
      const propData = page.properties[statusProp];
      
      if (propData) {
        const updateBody = { properties: {} };
        if (propData.type === 'status') {
          updateBody.properties[statusProp] = { status: { name: completeStatus } };
        } else if (propData.type === 'select') {
          updateBody.properties[statusProp] = { select: { name: completeStatus } };
        } else {
          return;
        }
        
        await notionApi(`/pages/${pageId}`, 'PATCH', updateBody, token);
        PluginAPI.showSnack({ msg: 'Notion task marked completed!', type: 'SUCCESS' });
      }
    } catch (e) {
      console.error('Failed to update Notion Task', e);
      // Fails silently if offline; runSync will catch it later!
    }
  }
});

let lastSyncTime = 0;
let lastProcessedManualRequest = 0;

setInterval(async () => {
  const currentConfig = await getPluginConfig();
  const freqMinutes = currentConfig.syncFrequency || 1;
  const freqMs = freqMinutes * 60 * 1000;
  const now = Date.now();

  const manualRequest = currentConfig.lastManualSyncRequest || 0;
  const shouldSyncManual = manualRequest > lastProcessedManualRequest;
  const shouldSyncAuto = now - lastSyncTime >= freqMs;

  if (shouldSyncManual || shouldSyncAuto) {
    if (shouldSyncManual) {
      lastProcessedManualRequest = manualRequest;
    }
    lastSyncTime = now;
    await runSync();
  }
}, 5000);

setTimeout(runSync, 5000);

console.log('Notion Sync plugin loaded!');
