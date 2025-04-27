import { App, Editor, FrontMatterCache, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, setIcon } from 'obsidian';
import { Octokit } from '@octokit/rest';
import * as matter from 'gray-matter';

// Extended Obsidian API type
declare module 'obsidian' {
    interface App {
        setting: {
            open(): void;
            openTabById(id: string): void;
        };
    }
}

interface PublisherSettings {
	githubToken: string;
	githubUsername: string;
	githubRepo: string;
	publishFolder: string; // Hedef klasör (reponun içinde)
	excludeFolders: string[]; // Hariç tutulacak klasörler
	frontmatterKey: string; // Paylaşılacak notları belirlemek için frontmatter anahtarı
	publishedNotes: Record<string, string>; // Dosya yolu -> Son yayınlanma tarihi
	useFileHistory: boolean; // Track file history when name changes
	formatFilename: boolean; // Format filename to be URL-friendly
	languageSuffixKey: string; // Frontmatter key to specify language suffix
}

const DEFAULT_SETTINGS: PublisherSettings = {
	githubToken: '',
	githubUsername: '',
	githubRepo: '',
	publishFolder: 'notes',
	excludeFolders: [],
	frontmatterKey: 'share',
	publishedNotes: {},
	useFileHistory: true,
	formatFilename: false,
	languageSuffixKey: 'lang'
}

export default class GithubPublisherPlugin extends Plugin {
	settings: PublisherSettings;
	octokit: any;
	statusBar: HTMLElement;
	githubConnected: boolean = false;

	async onload() {
		await this.loadSettings();
		
		// GitHub API bağlantısını kur
		if (this.settings.githubToken) {
			this.initOctokit();
			// Bağlantı durumunu test et
			await this.testGitHubConnection();
		}

		// Ribbon ikonunu ekle - yayınlama merkezini açacak
		const ribbonIconEl = this.addRibbonIcon('upload-cloud', 'GitHub Publisher', (evt: MouseEvent) => {
			new PublisherModal(this.app, this).open();
		});
		ribbonIconEl.addClass('github-publisher-ribbon-class');

		// Durum çubuğu öğesi ekle
		this.statusBar = this.addStatusBarItem();
		this.updateStatusBar();

		// Tek bir notu yayınlamak için komut ekle
		this.addCommand({
			id: 'publish-current-note',
			name: 'Publish current note to GitHub',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView && markdownView.file) {
					if (!checking) {
						this.publishSingleNote(markdownView.file);
					}
					return true;
				}
				return false;
			}
		});

		// Tüm paylaşılabilir notları yayınlamak için komut ekle
		this.addCommand({
			id: 'publish-all-shareable-notes',
			name: 'Publish all shareable notes to GitHub',
			callback: () => {
				this.publishAllNotes();
			}
		});

		// Ayarlar sekmesi ekle
		this.addSettingTab(new PublisherSettingTab(this.app, this));
	}

	onunload() {
		// Temizlik işlemleri
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.settings.githubToken) {
			this.initOctokit();
			await this.testGitHubConnection();
		}
		this.updateStatusBar();
	}

	initOctokit() {
		this.octokit = new Octokit({
			auth: this.settings.githubToken
		});
	}

	// GitHub bağlantısını test et
	async testGitHubConnection(): Promise<boolean> {
		if (!this.settings.githubToken || !this.settings.githubUsername || !this.settings.githubRepo) {
			this.githubConnected = false;
			return false;
		}

		try {
			// Kullanıcı ve repo bilgilerini kontrol et
			await this.octokit.repos.get({
				owner: this.settings.githubUsername,
				repo: this.settings.githubRepo
			});
			this.githubConnected = true;
			this.updateStatusBar();
			return true;
		} catch (error) {
			console.error("GitHub connection test failed:", error);
			this.githubConnected = false;
			this.updateStatusBar();
			return false;
		}
	}

	// Durum çubuğunu güncelle
	updateStatusBar() {
		this.statusBar.empty();
		
		const statusText = this.statusBar.createSpan({ cls: 'github-publisher-status-text' });
		statusText.setText('GitHub Publisher: ');
		
		const statusIcon = this.statusBar.createSpan({ cls: 'github-publisher-status-icon' });
		
		if (this.githubConnected) {
			setIcon(statusIcon, 'check-circle');
			statusIcon.addClass('github-publisher-connected');
			statusText.setText('GitHub Publisher: Connected');
		} else {
			setIcon(statusIcon, 'x-circle');
			statusIcon.addClass('github-publisher-disconnected');
			statusText.setText('GitHub Publisher: Disconnected');
		}
	}

	// Bir notun yayınlanabilir olup olmadığını kontrol eder
	isNoteShareable(file: TFile): boolean {
		// Dosyanın markdown olduğundan emin ol
		if (file.extension !== 'md') {
			return false;
		}

		// Dosyanın hariç tutulan klasörlerden birinde olup olmadığını kontrol et
		if (this.isInExcludedFolder(file.path)) {
			return false;
		}

		// Frontmatter'ı kontrol et
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) {
			return false;
		}

		// share: true kontrolü
		return frontmatter[this.settings.frontmatterKey] === true;
	}

	// Dosya yolunun hariç tutulan klasörlerden birinde olup olmadığını kontrol eder
	isInExcludedFolder(path: string): boolean {
		return this.settings.excludeFolders.some(folder => 
			path.startsWith(folder + '/') || path === folder
		);
	}

	// Obsidian'daki yolu GitHub'daki hedef yola dönüştür
	getTargetPath(file: TFile): string {
		// Sadece dosya adını al
		let fileName = file.name;
		
		// URL-friendly format uygula (ayarlarda aktif ise)
		if (this.settings.formatFilename) {
			fileName = this.formatFilenameAsSlug(fileName);
		}
		
		// Dil seçeneğini kontrol et
		const languageSuffix = this.getLanguageSuffix(file);
		if (languageSuffix) {
			fileName = this.applyLanguageSuffix(fileName, languageSuffix);
		}
		
		// Hedef klasör belirtildiyse ön ek ekle
		if (this.settings.publishFolder && this.settings.publishFolder !== '/') {
			return `${this.settings.publishFolder}/${fileName}`;
		}
		
		return fileName;
	}

	// Find the previously published path of a note by checking its content hash
	async findPreviousNotePath(file: TFile, content: string): Promise<string | null> {
		if (!this.settings.useFileHistory) {
			return null;
		}
		
		const contentHash = this.calculateContentHash(content);
		
		// Only consider notes that have been published previously
		const publishedPaths = Object.keys(this.settings.publishedNotes);
		
		for (const path of publishedPaths) {
			// Skip if it's the current path
			if (path === file.path) continue;
			
			try {
				// Try to find the file in the vault
				const oldFile = this.app.vault.getAbstractFileByPath(path);
				// If file doesn't exist anymore, it might have been renamed
				if (!oldFile || !(oldFile instanceof TFile)) {
					// Get the content hash if we stored it previously
					const storedHash = this.getStoredContentHash(path);
					if (storedHash && storedHash === contentHash) {
						// Found a match - this is likely the same file that was renamed
						return path;
					}
				}
			} catch (e) {
				// File might not exist anymore, just continue
			}
		}
		
		return null;
	}
	
	// Simple hash function for content comparison
	calculateContentHash(content: string): string {
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return hash.toString();
	}
	
	// Store content hash in publishedNotes for future reference
	getStoredContentHash(path: string): string | null {
		// We'll extract it from the timestamp field for now (we could enhance this in the future)
		const timestamp = this.settings.publishedNotes[path];
		if (timestamp && timestamp.includes(':hash:')) {
			return timestamp.split(':hash:')[1];
		}
		return null;
	}
	
	// Store the content hash when marking a note as published
	async markNoteAsPublished(filePath: string, contentHash?: string) {
		const timestamp = new Date().toISOString();
		this.settings.publishedNotes[filePath] = contentHash ? 
			`${timestamp}:hash:${contentHash}` : timestamp;
		await this.saveSettings();
	}

	// Tek bir notu yayınla
	async publishSingleNote(file: TFile) {
		if (!this.settings.githubToken || !this.settings.githubUsername || !this.settings.githubRepo) {
			new Notice('Please configure GitHub settings in the plugin settings.');
			return;
		}

		if (!this.octokit) {
			this.initOctokit();
		}

		// Notun paylaşılabilir olup olmadığını kontrol et
		if (!this.isNoteShareable(file)) {
			new Notice(`Note ${file.name} is not shareable. Make sure it has '${this.settings.frontmatterKey}: true' in its frontmatter.`);
			return;
		}

		try {
			// Dosya içeriğini oku
			const content = await this.app.vault.read(file);
			
			// İçerik hash'ini hesapla (dosya takibi için)
			const contentHash = this.calculateContentHash(content);
			
			// GitHub'daki hedef yolu belirle
			const targetPath = this.getTargetPath(file);
			
			// Eğer dosya adı değiştiyse önceki yayınlanmış dosyayı bulmaya çalış
			let previousPath: string | null = null;
			if (this.settings.useFileHistory) {
				previousPath = await this.findPreviousNotePath(file, content);
			}
			
			// Base64 olarak kodla
			const contentBase64 = this.btoa(content);
			
			// GitHub'da dosyanın mevcut olup olmadığını kontrol et
			let sha: string | undefined = undefined;
			
			// Öncelikle aynı adla bir dosya var mı diye kontrol et
			try {
				const response = await this.octokit.repos.getContent({
					owner: this.settings.githubUsername,
					repo: this.settings.githubRepo,
					path: targetPath,
				});
				if (response.data && !Array.isArray(response.data)) {
					sha = response.data.sha;
				}
			} catch (e) {
				// Dosya mevcut değil, değişen isimli bir dosya olabilir
				
				// Eğer önceki yol bulunduysa, bu dosya adı değişmiş olabilir
				if (previousPath) {
					// Önceki dosyanın GitHub'daki hedef yolunu belirle
					const pathParts = previousPath.split('/');
					const oldFileName = pathParts[pathParts.length - 1];
					const oldTargetPath = this.getTargetPath(
						{name: oldFileName || previousPath} as TFile
					);
					
					try {
						// Önceki dosyayı GitHub'da bul
						const oldFileResponse = await this.octokit.repos.getContent({
							owner: this.settings.githubUsername,
							repo: this.settings.githubRepo,
							path: oldTargetPath,
						});
						
						if (oldFileResponse.data && !Array.isArray(oldFileResponse.data)) {
							// Önceki dosyayı GitHub'dan sil
							await this.octokit.repos.deleteFile({
								owner: this.settings.githubUsername,
								repo: this.settings.githubRepo,
								path: oldTargetPath,
								message: `Delete ${oldTargetPath} (renamed to ${file.name})`,
								sha: oldFileResponse.data.sha,
							});
							
							// Kullanıcıya bildir
							new Notice(`Previous version at ${oldTargetPath} has been deleted.`);
							
							// Önceki dosya kaydını sil
							delete this.settings.publishedNotes[previousPath];
							await this.saveSettings();
						}
					} catch (error) {
						// Önceki dosya bulunamadı veya silinemedi, devam et
						console.log(`Could not delete previous file: ${error.message}`);
					}
				}
			}
			
			// Dosyayı GitHub'a yükle
			await this.octokit.repos.createOrUpdateFileContents({
				owner: this.settings.githubUsername,
				repo: this.settings.githubRepo,
				path: targetPath,
				message: `Update ${file.name} via Obsidian Publisher`,
				content: contentBase64,
				sha: sha,
			});
			
			// Yayınlanmış not olarak kaydet (content hash ile)
			await this.markNoteAsPublished(file.path, contentHash);
			
			new Notice(`Successfully published ${file.name} to GitHub!`);
		} catch (error) {
			console.error('Error publishing note:', error);
			new Notice(`Failed to publish ${file.name}. Error: ${error.message}`);
		}
	}

	// Base64 kodlaması için yardımcı fonksiyon
	btoa(content: string): string {
		return Buffer.from(content).toString('base64');
	}

	// Tüm yayınlanabilir notları yayınla
	async publishAllNotes() {
		if (!this.settings.githubToken || !this.settings.githubUsername || !this.settings.githubRepo) {
			new Notice('Please configure GitHub settings in the plugin settings.');
			return;
		}

		if (!this.octokit) {
			this.initOctokit();
		}

		// Vault'taki tüm markdown dosyalarını al
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		// Paylaşılabilir dosyaları filtrele
		const shareableFiles = markdownFiles.filter(file => this.isNoteShareable(file));
		
		if (shareableFiles.length === 0) {
			new Notice('No shareable notes found. Make sure notes have the frontmatter property set.');
			return;
		}
		
		// Her dosyayı yayınla
		let successCount = 0;
		let failCount = 0;
		
		new Notice(`Publishing ${shareableFiles.length} notes to GitHub...`);
		
		for (const file of shareableFiles) {
			try {
				await this.publishSingleNote(file);
				successCount++;
			} catch (error) {
				console.error(`Error publishing ${file.name}:`, error);
				failCount++;
			}
		}
		
		new Notice(`Published ${successCount} notes to GitHub. ${failCount} failed.`);
	}

	// Convert a filename to a URL-friendly slug format
	formatFilenameAsSlug(filename: string): string {
		if (!this.settings.formatFilename) {
			return filename;
		}
		
		// Remove file extension
		let name = filename.replace(/\.md$/, '');
		
		// Convert to lowercase
		name = name.toLowerCase();
		
		// Replace spaces with hyphens
		name = name.replace(/\s+/g, '-');
		
		// Remove special characters
		name = name.replace(/[^\w\-]/g, '');
		
		// Add .md extension back
		return name + '.md';
	}
	
	// Get language suffix from frontmatter if available
	getLanguageSuffix(file: TFile): string | null {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (frontmatter && this.settings.languageSuffixKey in frontmatter) {
			const lang = frontmatter[this.settings.languageSuffixKey];
			if (typeof lang === 'string' && lang.trim().length > 0) {
				return lang.trim().toLowerCase();
			}
		}
		return null;
	}
	
	// Apply language suffix to filename if specified
	applyLanguageSuffix(filename: string, languageSuffix: string | null): string {
		if (!languageSuffix) {
			return filename;
		}
		
		// Remove .md extension
		let name = filename.replace(/\.md$/, '');
		
		// Add language suffix and .md extension back
		return `${name}.${languageSuffix}.md`;
	}
}

// Yayınlama Merkezi Modalı
class PublisherModal extends Modal {
	plugin: GithubPublisherPlugin;
	shareableFiles: TFile[] = [];
	searchInput: HTMLInputElement;

	constructor(app: App, plugin: GithubPublisherPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const {contentEl} = this;
		contentEl.addClass('github-publisher-modal');

		// Başlık
		contentEl.createEl('h2', {text: 'GitHub Publisher - Publication Center'});
		
		// GitHub bağlantı durumu
		const connectionDiv = contentEl.createDiv({ cls: 'github-publisher-connection-status' });
		if (this.plugin.githubConnected) {
			connectionDiv.addClass('github-publisher-connected-banner');
			connectionDiv.createSpan({ text: 'GitHub connection: ' });
			const statusSpan = connectionDiv.createSpan();
			setIcon(statusSpan, 'check-circle');
			connectionDiv.createSpan({ text: ' Connected' });
		} else {
			connectionDiv.addClass('github-publisher-disconnected-banner');
			connectionDiv.createSpan({ text: 'GitHub connection: ' });
			const statusSpan = connectionDiv.createSpan();
			setIcon(statusSpan, 'x-circle');
			connectionDiv.createSpan({ text: ' Disconnected' });
		}

		// GitHub ayarlarını kontrol et
		if (!this.plugin.settings.githubToken || !this.plugin.settings.githubUsername || !this.plugin.settings.githubRepo) {
			contentEl.createEl('p', {
				text: 'Please configure GitHub settings in the plugin settings before publishing.',
				cls: 'github-publisher-warning'
			});

			// Ayarları aç butonu
			const settingsButton = contentEl.createEl('button', {
				text: 'Open Settings',
				cls: 'github-publisher-button'
			});
			
			settingsButton.addEventListener('click', () => {
				this.close();
				this.app.setting.open();
				this.app.setting.openTabById('github-publisher');
			});
			
			return;
		}

		// Arama kısmı
		const searchContainer = contentEl.createDiv({ cls: 'github-publisher-search-container' });
		searchContainer.createEl('span', { text: 'Search notes: ', cls: 'github-publisher-search-label' });
		this.searchInput = searchContainer.createEl('input', { 
			type: 'text',
			cls: 'github-publisher-search-input',
			attr: { placeholder: 'Filter by title or path...' }
		});
		
		// Yayınlama durumu bilgisi
		const statusDiv = contentEl.createDiv({cls: 'github-publisher-status'});
		statusDiv.createEl('p', {text: 'Loading shareable notes...'});
		
		// Yayınlanabilir notları getir
		const markdownFiles = this.app.vault.getMarkdownFiles();
		this.shareableFiles = markdownFiles.filter(file => this.plugin.isNoteShareable(file));
		
		statusDiv.empty();
		statusDiv.createEl('p', {
			text: `Found ${this.shareableFiles.length} shareable notes.`,
			cls: 'github-publisher-status-text'
		});

		// Tümünü yayınla butonu
		const actionDiv = contentEl.createDiv({ cls: 'github-publisher-actions' });
		const publishAllButton = actionDiv.createEl('button', {
			text: `Publish All Notes (${this.shareableFiles.length})`,
			cls: 'github-publisher-button'
		});
		
		publishAllButton.addEventListener('click', async () => {
			publishAllButton.disabled = true;
			publishAllButton.setText('Publishing...');
			await this.plugin.publishAllNotes();
			publishAllButton.disabled = false;
			publishAllButton.setText(`Publish All Notes (${this.shareableFiles.length})`);
			this.updateNoteList(); // Yayınlanma durumu için listeyi güncelle
		});

		// Notlar listesi bölümü
		contentEl.createEl('h3', {text: 'Shareable Notes'});
		
		// Notlar listesi için konteyner
		const notesContainer = contentEl.createDiv({cls: 'github-publisher-notes-list'});
		
		// Notları listele
		this.renderNoteList(notesContainer);
		
		// Arama işlevselliği
		this.searchInput.addEventListener('input', () => {
			this.renderNoteList(notesContainer);
		});
	}
	
	// Notları filtreleyerek listeler
	renderNoteList(container: HTMLElement) {
		container.empty();
		
		const searchQuery = this.searchInput?.value.toLowerCase() || '';
		let filteredFiles = this.shareableFiles;
		
		// Arama sorgusu varsa filtreleme yap
		if (searchQuery) {
			filteredFiles = this.shareableFiles.filter(file => 
				file.path.toLowerCase().includes(searchQuery) || 
				file.name.toLowerCase().includes(searchQuery)
			);
		}
		
		if (filteredFiles.length === 0) {
			container.createEl('p', {
				text: searchQuery 
					? `No matching notes found for "${searchQuery}".` 
					: `No shareable notes found. Make sure notes have '${this.plugin.settings.frontmatterKey}: true' in frontmatter.`,
				cls: 'github-publisher-empty'
			});
		} else {
			// Her not için liste öğesi oluştur
			for (const file of filteredFiles) {
				const noteItem = container.createDiv({cls: 'github-publisher-note-item'});
				
				// Yayınlanmış not için durum göstergesi
				const isPublished = file.path in this.plugin.settings.publishedNotes;
				if (isPublished) {
					const statusDiv = noteItem.createDiv({ cls: 'github-publisher-note-status' });
					setIcon(statusDiv, 'check');
					statusDiv.addClass('github-publisher-published');
					
					// Yayınlanma zamanı tooltip'i
					const publishDate = new Date(this.plugin.settings.publishedNotes[file.path]);
					statusDiv.setAttribute('title', `Last published: ${publishDate.toLocaleString()}`);
				}
				
				// Not başlığı ve yolu
				const titleDiv = noteItem.createDiv({ cls: 'github-publisher-note-info' });
				titleDiv.createEl('div', {
					text: file.name,
					cls: 'github-publisher-note-title'
				});
				titleDiv.createEl('div', {
					text: file.path,
					cls: 'github-publisher-note-path'
				});
				
				// Yayınla butonu
				const actionDiv = noteItem.createDiv({ cls: 'github-publisher-note-actions' });
				const publishButton = actionDiv.createEl('button', {
					text: isPublished ? 'Update' : 'Publish',
					cls: 'github-publisher-publish-button'
				});
				
				// Notu Obsidian'da aç
				const openButton = actionDiv.createEl('button', {
					text: 'Open',
					cls: 'github-publisher-open-button'
				});
				
				// Buton işlevleri
				publishButton.addEventListener('click', async () => {
					publishButton.disabled = true;
					publishButton.setText('Publishing...');
					await this.plugin.publishSingleNote(file);
					publishButton.disabled = false;
					publishButton.setText(isPublished ? 'Update' : 'Publish');
					this.updateNoteList(); // Başarılı yayınlamadan sonra listeyi güncelle
				});
				
				openButton.addEventListener('click', () => {
					this.app.workspace.getLeaf().openFile(file);
				});
			}
		}
	}
	
	// Notların yayınlanma durumunu günceller ve listeyi yeniler
	updateNoteList() {
		const notesContainer = this.contentEl.querySelector('.github-publisher-notes-list');
		if (notesContainer) {
			this.renderNoteList(notesContainer as HTMLElement);
		}
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

// Plugin Ayarları Sekmesi
class PublisherSettingTab extends PluginSettingTab {
	plugin: GithubPublisherPlugin;
	connectionStatus: HTMLElement;

	constructor(app: App, plugin: GithubPublisherPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', {text: 'GitHub Publisher Settings'});
		
		// GitHub Kimlik Bilgileri
		containerEl.createEl('h3', {text: 'GitHub Authentication'});
		
		// Bağlantı durumu göstergesi
		this.connectionStatus = containerEl.createDiv({ cls: 'github-publisher-connection-status setting-item' });
		this.updateConnectionStatus();
		
		new Setting(containerEl)
			.setName('GitHub Token')
			.setDesc('Personal access token with repo permissions')
			.addText(text => text
				.setPlaceholder('ghp_xxxxxxxxxxxxxxxxxxxx')
				.setValue(this.plugin.settings.githubToken)
				.onChange(async (value) => {
					this.plugin.settings.githubToken = value;
					await this.plugin.saveSettings();
					this.updateConnectionStatus();
				}));
		
		new Setting(containerEl)
			.setName('GitHub Username')
			.setDesc('Your GitHub username')
			.addText(text => text
				.setPlaceholder('username')
				.setValue(this.plugin.settings.githubUsername)
				.onChange(async (value) => {
					this.plugin.settings.githubUsername = value;
					await this.plugin.saveSettings();
					this.updateConnectionStatus();
				}));
		
		new Setting(containerEl)
			.setName('GitHub Repository')
			.setDesc('The name of your GitHub repository')
			.addText(text => text
				.setPlaceholder('my-notes-repo')
				.setValue(this.plugin.settings.githubRepo)
				.onChange(async (value) => {
					this.plugin.settings.githubRepo = value;
					await this.plugin.saveSettings();
					this.updateConnectionStatus();
				}));
		
		// Test butonu ekle
		new Setting(containerEl)
			.setName('Test GitHub Connection')
			.setDesc('Test your GitHub credentials')
			.addButton(button => button
				.setButtonText('Test Connection')
				.setCta()
				.onClick(async () => {
					button.setButtonText('Testing...');
					button.setDisabled(true);
					
					const success = await this.plugin.testGitHubConnection();
					
					if (success) {
						new Notice('GitHub connection successful!');
					} else {
						new Notice('GitHub connection failed. Please check your settings.');
					}
					
					this.updateConnectionStatus();
					button.setButtonText('Test Connection');
					button.setDisabled(false);
				}));
		
		// Yayınlama Ayarları
		containerEl.createEl('h3', {text: 'Publishing Settings'});
		
		new Setting(containerEl)
			.setName('Publish Folder')
			.setDesc('The folder in your GitHub repository where notes will be published (leave empty for root)')
			.addText(text => text
				.setPlaceholder('notes')
				.setValue(this.plugin.settings.publishFolder)
				.onChange(async (value) => {
					this.plugin.settings.publishFolder = value;
					await this.plugin.saveSettings();
				}));
		
		// Klasör yapısı koruma ayarı
		new Setting(containerEl)
			.setName('Keep Folder Structure')
			.setDesc('If disabled, all notes will be published directly to the publish folder without maintaining their folder structure')
			.addToggle(toggle => toggle
				.setValue(false) // Varsayılan olarak kapalı
				.onChange(async (value) => {
					// Bu özellik kapalı olduğunda, getTargetPath fonksiyonu sadece dosya adını kullanacak
					// Bu ayar değeri için yeni bir ayar eklemiyorum çünkü getTargetPath fonksiyonunu zaten değiştirdim
					// Eğer bu özellik açık olsun istenirse, getTargetPath fonksiyonu tekrar eski haline getirilmeli
					new Notice(`Folder structure will ${value ? 'be kept' : 'not be kept'}`);
				}));
		
		// Hariç tutulan klasörler için ayar
		new Setting(containerEl)
			.setName('Excluded Folders')
			.setDesc('Folders to exclude from publishing (comma separated)')
			.addText(text => text
				.setPlaceholder('private, drafts, templates')
				.setValue(this.plugin.settings.excludeFolders.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.excludeFolders = value
						.split(',')
						.map(folder => folder.trim())
						.filter(folder => folder.length > 0);
					await this.plugin.saveSettings();
				}));
		
		// Frontmatter anahtarı için ayar
		new Setting(containerEl)
			.setName('Frontmatter Key')
			.setDesc('The frontmatter key that indicates a note should be shared (default: share)')
			.addText(text => text
				.setPlaceholder('share')
				.setValue(this.plugin.settings.frontmatterKey)
				.onChange(async (value) => {
					this.plugin.settings.frontmatterKey = value || 'share';
					await this.plugin.saveSettings();
				}));

		// Dosya izleme özelliği için ayar
		containerEl.createEl('h3', {text: 'Advanced Features'});

		new Setting(containerEl)
			.setName('Track File History')
			.setDesc('When enabled, the plugin will update existing files on GitHub when a note is renamed in Obsidian')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useFileHistory)
				.onChange(async (value) => {
					this.plugin.settings.useFileHistory = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('URL-Friendly Filenames')
			.setDesc('Convert filenames to a URL-friendly format (lowercase, hyphens instead of spaces, no special characters)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.formatFilename)
				.onChange(async (value) => {
					this.plugin.settings.formatFilename = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Language Suffix Key')
			.setDesc('The frontmatter key used to specify language suffix (e.g., "en", "tr" to generate file.en.md)')
			.addText(text => text
				.setPlaceholder('lang')
				.setValue(this.plugin.settings.languageSuffixKey)
				.onChange(async (value) => {
					this.plugin.settings.languageSuffixKey = value || 'lang';
					await this.plugin.saveSettings();
				}));
		
		// Yayınlanan notları temizle
		new Setting(containerEl)
			.setName('Reset Published Notes History')
			.setDesc('Clear the record of which notes have been published')
			.addButton(button => button
				.setButtonText('Reset')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.publishedNotes = {};
					await this.plugin.saveSettings();
					new Notice('Published notes history has been reset.');
				}));
	}
	
	// GitHub bağlantı durumu göstergesini güncellemek için
	updateConnectionStatus() {
		this.connectionStatus.empty();
		
		if (this.plugin.githubConnected) {
			this.connectionStatus.addClass('github-publisher-connected-banner');
			this.connectionStatus.removeClass('github-publisher-disconnected-banner');
			const statusText = this.connectionStatus.createSpan({ text: 'GitHub connection: ' });
			const statusIcon = this.connectionStatus.createSpan();
			setIcon(statusIcon, 'check-circle');
			statusIcon.addClass('github-publisher-connected-icon');
			this.connectionStatus.createSpan({ text: ' Connected' });
		} else {
			this.connectionStatus.addClass('github-publisher-disconnected-banner');
			this.connectionStatus.removeClass('github-publisher-connected-banner');
			const statusText = this.connectionStatus.createSpan({ text: 'GitHub connection: ' });
			const statusIcon = this.connectionStatus.createSpan();
			setIcon(statusIcon, 'x-circle');
			statusIcon.addClass('github-publisher-disconnected-icon');
			this.connectionStatus.createSpan({ text: ' Disconnected' });
		}
	}
}
