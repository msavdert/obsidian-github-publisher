# Obsidian GitHub Publisher Plugin

This Obsidian plugin allows you to automatically publish your Markdown notes with a "share: true" frontmatter property (or another key you define in settings) to your GitHub repository. It's inspired by the [Digital Garden](https://github.com/oleeskild/obsidian-digital-garden) project, but focuses exclusively on GitHub publishing functionality.

## Features

- 📤 Publish your Markdown notes directly to GitHub
- 📂 Choose whether to maintain folder structure or publish all notes to a single folder
- 🔍 Only publish notes with the `share: true` frontmatter property
- ⛔ Exclude specific folders from publishing
- 🔄 Digital Garden-like publication center to manage all shareable notes
- ✅ Visual indicators for successful GitHub connection and published notes
- 🔄 Track which notes have been published with update/publish status indicators

## Installation

1. Open "Community Plugins" in Obsidian Settings
2. Click "Browse" and search for "GitHub Publisher"
3. Install the plugin
4. Enable the GitHub Publisher plugin

## Configuration

### GitHub Authentication

You need to create a GitHub Personal Access Token (PAT) to use this plugin:

1. Create a [new Personal Access Token](https://github.com/settings/tokens/new) on GitHub
2. Select "repo" permissions for the token
3. Copy the token and paste it into the plugin settings
4. Enter your GitHub username and repository name
5. Use the "Test Connection" button to verify your credentials

### Publishing Settings

- **Publish Folder**: The root folder in your GitHub repository where notes will be published
- **Keep Folder Structure**: Toggle whether to maintain the folder structure from Obsidian or publish all notes directly to the publish folder
- **Excluded Folders**: Obsidian folders you don't want to publish (comma-separated)
- **Frontmatter Key**: The frontmatter property that indicates a note should be shared (default: "share")

## Usage

### Preparing Notes

Add `share: true` to the frontmatter of any note you want to publish:

```markdown
---
share: true
---

# Title

Note content...
```

### Publishing

There are two methods to publish notes:

1. **Single Note Publishing**: Click the ribbon icon in the left sidebar or use the command palette to "Publish current note to GitHub"
2. **Batch Publishing**: Click the ribbon icon to open the Publication Center and use the "Publish All Notes" button

### Publication Center

The Publication Center provides:

- List of all shareable notes with their publication status
- Search functionality to filter notes
- Individual publish/update buttons for each note
- Visual indicators showing which notes have already been published
- A button to open the note in Obsidian for editing

## Troubleshooting

- **Publishing Fails**: Ensure your GitHub token is correct and valid (check the connection indicator)
- **Notes Not Publishing**: Verify that notes have `share: true` in their frontmatter
- **Folder Structure Issues**: Check your "Keep Folder Structure" setting and publish folder configuration

## Support and Development

For issues, feature requests, or contributions, please visit [our GitHub repository](https://github.com/yourusername/obsidian-github-publisher).

## License

This plugin is licensed under the MIT License.
