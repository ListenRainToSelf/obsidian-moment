import {
	App,
	PluginSettingTab,
	Setting,
	Notice,
} from "obsidian";
import type MomentPlugin from "./main";
import { DEFAULT_QUOTES, DEFAULT_MOODS } from "./constants";

/** 插件设置 */
export interface MomentSettings {
	/** 内容根目录（绝对路径或库内相对路径） */
	rootPath: string;
	/** 附件目录名 */
	attachmentDir: string;
	/** 朋友圈背景（签名上方，默认留空用默认图） */
	signature: string;
	/** 名言池，展示时随机取一条 */
	quotes: string[];
	/** 界面样式：卡片式 / 平面式 */
	styleMode: "card" | "flat";
	/** 动态图片排列：九宫格 / 卡片堆叠 */
	imageMode: "grid" | "stack";
	/** 背景文件名识别名（附件目录内的这张图即朋友圈背景） */
	coverName: string;
	/** 背景类型：本地图片 / 纯色 / 渐变 / 网络URL */
	coverMode: "file" | "color" | "gradient" | "url";
	/** 纯色背景色（coverMode=color 时生效） */
	bgColor: string;
	/** 渐变起止色（coverMode=gradient 时生效） */
	gradientA: string;
	gradientB: string;
	/** 网络背景 URL（coverMode=url 时生效） */
	bgUrl: string;
	/** 正文字体颜色（留空则跟随主题） */
	textColor: string;
	/** 背景图片默认显示高度段（0-6，共 7 档：0=顶 … 6=底） */
	coverAlign: number;
	/** 心情候选（发布时可选择，可增删） */
	moods: string[];
}

export const DEFAULT_SETTINGS: MomentSettings = {
	rootPath: "",
	attachmentDir: "附件",
	signature: "把日子过成想要的样子",
	quotes: [...DEFAULT_QUOTES],
	styleMode: "card",
	imageMode: "grid",
	coverName: "img.jpg",
	coverMode: "file",
	bgColor: "#c9d7ea",
	gradientA: "#9fc7e8",
	gradientB: "#c9bde8",
	bgUrl: "",
	textColor: "",
	coverAlign: 3,
	moods: [...DEFAULT_MOODS],
};

/** 生成日期对应路径的工具 */
export function dateParts(d: Date) {
	const y = d.getFullYear();
	const m = d.getMonth() + 1;
	const day = d.getDate();
	return {
		year: y,
		month: m,
		day,
		/** 月份目录名，如 "2026-9" */
		monthDir: `${y}-${m}`,
		/** 日期键，如 "2026-9-10" */
		dateKey: `${y}-${m}-${day}`,
	};
}

export default class MomentSettingTab extends PluginSettingTab {
	plugin: MomentPlugin;

	constructor(app: App, plugin: MomentPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "此刻 MOMENT" });
		containerEl.createEl("p", {
			text: "朋友圈式日记。内容以标准 markdown 存于本地，任何编辑器都可读取。",
			attr: { class: "moment-settings-hint" },
		});

		// 界面样式
		new Setting(containerEl)
			.setName("界面样式")
			.setDesc("卡片式：磨砂玻璃卡片；平面式：无卡片、更简洁扁平。")
			.addDropdown((dd) =>
				dd
					.addOption("card", "卡片式")
					.addOption("flat", "平面式")
					.setValue(this.plugin.settings.styleMode)
					.onChange(async (v) => {
						this.plugin.settings.styleMode =
							v as MomentSettings["styleMode"];
						await this.plugin.saveSettings();
						this.plugin.applyStyle();
					})
			);

		// 动态图片排列
			new Setting(containerEl)
				.setName("动态图片排列")
				.setDesc("网格：仿微信九宫格缩略；卡片：大图竖向堆叠成卡片。单击图片放大预览，可左右键切换。")
				.addDropdown((dd) =>
					dd
						.addOption("grid", "九宫格")
						.addOption("stack", "卡片堆叠")
						.setValue(this.plugin.settings.imageMode)
						.onChange(async (v) => {
							this.plugin.settings.imageMode =
								v as MomentSettings["imageMode"];
							await this.plugin.saveSettings();
							this.plugin.applyImageMode();
						})
				);

			// 根目录
		new Setting(containerEl)
			.setName("内容根目录")
			.setDesc("绝对路径或库内相对路径。正文按月、附件分别落到该路径下的目录。")
			.addText((text) =>
				text
					.setPlaceholder("如 Vault 子目录 `` 或 D:/notes/moment")
					.setValue(this.plugin.settings.rootPath)
					.onChange(async (v) => {
						this.plugin.settings.rootPath = v.trim();
						await this.plugin.saveSettings();
					})
			);

		// 附带目录名
		new Setting(containerEl)
			.setName("附件目录名")
			.setDesc("正文目录平级下的附件目录名。")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.attachmentDir)
					.onChange(async (v) => {
						this.plugin.settings.attachmentDir =
							v.trim() || DEFAULT_SETTINGS.attachmentDir;
						await this.plugin.saveSettings();
					})
			);

		// 背景文件名
			new Setting(containerEl)
				.setName("背景文件名")
				.setDesc("仅当背景类型为“本地图片”时使用：附件目录内这张文件即朋友圈背景（含扩展名）。")
				.addText((text) =>
					text
						.setValue(this.plugin.settings.coverName)
						.onChange(async (v) => {
							this.plugin.settings.coverName =
								v.trim() || DEFAULT_SETTINGS.coverName;
							await this.plugin.saveSettings();
							this.plugin.reloadCover();
						})
				);

			// —— 外观 / 主题 ——
			containerEl.createEl("h3", { text: "外观 · 主题" });
			containerEl.createEl("p", {
				text: "自定义封面背景与文字颜色，改动即时生效。",
				attr: { class: "moment-settings-hint" },
			});

			// 背景类型
			new Setting(containerEl)
				.setName("背景类型")
				.setDesc("封面用怎样的背景：本地图片 / 纯色 / 渐变 / 网络图片。")
				.addDropdown((dd) =>
					dd
						.addOption("file", "本地图片")
						.addOption("color", "纯色")
						.addOption("gradient", "渐变")
						.addOption("url", "网络URL")
						.setValue(this.plugin.settings.coverMode)
						.onChange(async (v) => {
							this.plugin.settings.coverMode =
								v as MomentSettings["coverMode"];
							await this.plugin.saveSettings();
							this.plugin.reloadCover();
						})
				);

			// 纯色
			new Setting(containerEl)
				.setName("纯色背景")
				.setDesc("背景类型为“纯色”时生效。")
				.addColorPicker((cp) => {
					cp.setValue(this.plugin.settings.bgColor || "#c9d7ea");
					cp.onChange(async (v) => {
						this.plugin.settings.bgColor = v;
						await this.plugin.saveSettings();
						this.plugin.reloadCover();
					});
				});

			// 渐变
			new Setting(containerEl)
				.setName("渐变起色")
				.setDesc("背景类型为“渐变”时生效。")
				.addColorPicker((cp) => {
					cp.setValue(this.plugin.settings.gradientA || "#9fc7e8");
					cp.onChange(async (v) => {
						this.plugin.settings.gradientA = v;
						await this.plugin.saveSettings();
						this.plugin.reloadCover();
					});
				});
			new Setting(containerEl)
				.setName("渐变止色")
				.setDesc("背景类型为“渐变”时生效。")
				.addColorPicker((cp) => {
					cp.setValue(this.plugin.settings.gradientB || "#c9bde8");
					cp.onChange(async (v) => {
						this.plugin.settings.gradientB = v;
						await this.plugin.saveSettings();
						this.plugin.reloadCover();
					});
				});

			// 网络图片 URL
			new Setting(containerEl)
				.setName("网络图片 URL")
				.setDesc("背景类型为“网络URL”时生效，填入图片直链（https://…）。")
				.addText((text) =>
					text
						.setPlaceholder("https://example.com/cover.jpg")
						.setValue(this.plugin.settings.bgUrl)
						.onChange(async (v) => {
							this.plugin.settings.bgUrl = v.trim();
							await this.plugin.saveSettings();
							this.plugin.reloadCover();
						})
				);

			// 文字颜色
			new Setting(containerEl)
					.setName("文字颜色")
					.setDesc("正文 / 卡片文字颜色，留空则跟随 Obsidian 主题。")
					.addText((text) =>
						text
							.setPlaceholder("空 = 跟随主题，如 #1a1f2e")
							.setValue(this.plugin.settings.textColor)
							.onChange(async (v) => {
								this.plugin.settings.textColor = v.trim();
								await this.plugin.saveSettings();
								this.plugin.applyTheme();
							})
					);

			// 背景图片显示高度段（7 档）
			new Setting(containerEl)
				.setName("背景图片高度段")
				.setDesc("正常时封面包裹图片的哪一段（共 7 档，从顶到底）；鼠标悬停时展开整图。")
				.addDropdown((dd) => {
					const labels = ["顶", "偏上", "中上", "居中", "中下", "偏下", "底"];
					for (let i = 0; i < 7; i++) {
						dd.addOption(String(i), `第${i + 1}档 · ${labels[i]}`);
					}
					dd.setValue(String(this.plugin.settings.coverAlign ?? 3));
					dd.onChange(async (v) => {
						this.plugin.settings.coverAlign = Number(v);
						await this.plugin.saveSettings();
						this.plugin.refreshCover();
					});
				});

		// 签名
		new Setting(containerEl)
			.setName("签名")
			.setDesc("显示在朋友圈背景右下角的一句话。")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.signature)
					.onChange(async (v) => {
						this.plugin.settings.signature = v;
						await this.plugin.saveSettings();
						this.plugin.refreshCover();
					})
			);

		// 名言池
		containerEl.createEl("h3", { text: "每日名言池" });
		containerEl.createEl("p", {
			text: "灰分界线上方随机展示一句；留空则该行为隐藏。",
			attr: { class: "moment-settings-hint" },
		});

		const listEl = containerEl.createDiv();
		const renderQuotes = () => {
			listEl.empty();
			this.plugin.settings.quotes.forEach((q, idx) => {
				const row = listEl.createDiv({ cls: "moment-quote-row" });
				new Setting(row)
					.setName(`名言 ${idx + 1}`)
					.setDesc("修改后回车保存；删除则移除这句。")
					.addText((text) =>
						text.setValue(q).onChange(async (v) => {
							this.plugin.settings.quotes[idx] = v;
							await this.plugin.saveSettings();
						})
					)
					.addExtraButton((btn) =>
						btn
							.setIcon("trash")
							.setTooltip("删除")
							.onClick(async () => {
								this.plugin.settings.quotes =
									this.plugin.settings.quotes.filter(
										(_, i) => i !== idx
									);
								await this.plugin.saveSettings();
								renderQuotes();
							})
					);
			});
		};
		renderQuotes();

		new Setting(containerEl)
			.addButton((btn) =>
				btn.setButtonText("＋ 添加名言").onClick(async () => {
					this.plugin.settings.quotes.push("");
					await this.plugin.saveSettings();
					renderQuotes();
				})
			);

		// 心情候选
		containerEl.createEl("h3", { text: "心情候选" });
		containerEl.createEl("p", {
			text: "发布动态时可选择的心情。可自由添加或删除。",
			attr: { class: "moment-settings-hint" },
		});

		const moodListEl = containerEl.createDiv();
		const defaultMoods = (this.plugin.settings.moods || []).length
			? this.plugin.settings.moods
			: [...DEFAULT_MOODS];
		this.plugin.settings.moods = defaultMoods;
		const renderMoods = () => {
			moodListEl.empty();
			this.plugin.settings.moods.forEach((m, idx) => {
				const row = moodListEl.createDiv({ cls: "moment-quote-row" });
				new Setting(row)
					.setName(`心情 ${idx + 1}`)
					.setDesc("修改后回车保存；删除则移除这个心情。")
					.addText((text) =>
						text.setValue(m).onChange(async (v) => {
							this.plugin.settings.moods[idx] = v;
							await this.plugin.saveSettings();
						})
					)
					.addExtraButton((btn) =>
						btn
							.setIcon("trash")
							.setTooltip("删除")
							.onClick(async () => {
								this.plugin.settings.moods =
									this.plugin.settings.moods.filter(
										(_, i) => i !== idx
									);
								await this.plugin.saveSettings();
								renderMoods();
							})
					);
			});
		};
		renderMoods();

		new Setting(containerEl)
			.addButton((btn) =>
				btn.setButtonText("＋ 添加心情").onClick(async () => {
					this.plugin.settings.moods.push("");
					await this.plugin.saveSettings();
					renderMoods();
				})
			);

		// 重置默认
		new Setting(containerEl)
			.addButton((btn) =>
				btn
					.setButtonText("恢复默认设置")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings = { ...DEFAULT_SETTINGS };
						await this.plugin.saveSettings();
						this.display();
						new Notice("已恢复默认设置");
						})
				);
	}
}