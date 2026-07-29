# SuperProductivity-Notion-sync

This plugin provides a seamless two-way sync between your [Notion](https://www.notion.so/) databases and [Super Productivity](https://super-productivity.com/) projects. 

Import tasks directly from any Notion database, optionally bring over descriptions or entire page bodies into your task notes, and have tasks automatically complete in Notion when you check them off in Super Productivity.

## Features
- **Multi-Database Mapping:** Connect multiple Notion databases to different Super Productivity projects simultaneously.
- **Custom Status Mapping:** Choose exactly which Notion statuses (e.g., "To Do", "In Progress", or even Blank) import into Super Productivity, and which status is applied when a task is completed.
- **Deep Content Sync:** Pull specific database properties (like "Summary") or the entire block-based Page Body into Super Productivity's Notes field using a built-in Markdown converter.
- **Offline Resolution:** Automatically syncs completions back to Notion even if the plugin was temporarily disabled or you were offline when completing tasks.

---

## 🚀 Installation & Setup

### 1. Download the Plugin
1. Go to the [Releases page](../../releases) for this repository.
2. Download the latest `SuperProductivity-Notion-sync.zip` file attached to the release. *(Do not unzip it!)*

### 2. Install in Super Productivity
1. Open Super Productivity.
2. Click the **Settings** option at the bottom of the left side menu.
3. Select the **Plugins** tab in the top row.
4. Under "Install Plugin", click **Choose Plugin File** and select the `SuperProductivity-Notion-sync.zip` file you just downloaded.
5. You should now see a new **Notion Sync** icon in the top right menu. Clicking this icon opens the side panel on the right side.

### 3. Generate a Notion Integration Token
Notion requires a secret token so the plugin can securely read your databases.
1. Log into your Notion account and navigate to the [My Integrations](https://www.notion.so/my-integrations) dashboard.
2. Click **New connection**.
3. Name it "Super Productivity Sync" and select the workspace you want to sync.
4. Click **Submit** / **Create connection**.
5. Copy the generated **Internal Integration Secret**.

### 4. Give the Connection Access to your Databases
**Important:** The integration token can only see databases you explicitly share with it!
1. Open the Notion page containing the database you want to sync.
2. Click the three dots `...` in the top right corner of the page.
3. Scroll down to **Add connections** (or "Connect to").
4. Search for "Super Productivity Sync" and select it.
5. Click **Confirm**.

### 5. Connect and Map in the Plugin
1. Open the **Notion Sync** side panel in Super Productivity.
2. Paste your Internal Integration Secret into the **Access Token** field and click **Save Credentials & Connect**. The plugin will securely fetch all databases you shared with it.
3. Click **Add Mapping** to link a Notion Database to a Super Productivity Project.
4. Set up your desired import statuses and complete status.
5. *(Optional)* Select a **Task Notes Mapping** to pull in a database description property, or pull in the full Notion Page Body. *(Note: Pulling the full page body adds a slight delay to respect Notion's API rate limits).*
6. Click **Save Mappings** and then **Sync Now** to pull in your tasks!

---

## 🛠️ Development

If you'd like to modify this plugin or build it from source:

1. Clone this repository.
2. Make your edits to `index.html` or `plugin.js`.
3. To package the plugin, simply zip the three core files together at the root level (do not wrap them inside a folder):
   ```bash
   # On macOS / Linux
   zip SuperProductivity-Notion-sync.zip manifest.json index.html plugin.js
   
   # On Windows (PowerShell)
   Compress-Archive -Path manifest.json, index.html, plugin.js -DestinationPath SuperProductivity-Notion-sync.zip
   ```
4. Upload `SuperProductivity-Notion-sync.zip` to Super Productivity to test your changes.

---

## Technical Architecture
- **`manifest.json`**: Declares plugin permissions and capabilities.
- **`index.html`**: Renders the sandboxed user interface in the side panel. Handles configuration parsing and Notion DB lookup.
- **`plugin.js`**: Runs in the background of the host application, accessing `PluginAPI` to manage task creation, completion, and the background synchronization loop. Uses `postMessage` to communicate status updates back to the sandboxed UI.
