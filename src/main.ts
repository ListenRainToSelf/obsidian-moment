import { Plugin, WorkspaceLeaf } from "obsidian";
import { MOMENT_VIEW_TYPE } from "./constants";
import MomentSettingTab, { MomentSettings, DEFAULT_SETTINGS } from "./settings";
import { MomentView } from "./view";

const HEARTBEAT_MS = 30_000;

/** 内置界面主题的 body class 前缀（styles.css: body.moment-ui-theme-<id>） */
const UI_THEME_CLASS_PREFIX = "moment-ui-theme-";

export default class MomentPlugin extends Plugin {
	settings!: MomentSettings;

	async onload() {
		await this.loadSettings();
		this.applyUiTheme();
		this.addSettingTab(new MomentSettingTab(this.app, this));

		// 注册视图
		this.registerView(
			MOMENT_VIEW_TYPE,
			(leaf) => new MomentView(leaf, this)
		);

		// 左侧栏图标
		this.addRibbonIcon("camera", "此刻 MOMENT", () => {
			this.activateView();
		});

		// 命令：打开朋友圈
		this.addCommand({
			id: "open-moment",
			name: "打开朋友圈视图",
			callback: () => this.activateView(),
		});

		// 命令：跳到今天 / 发布
		this.addCommand({
			id: "publish-moment",
			name: "发布一条此刻动态",
			callback: () => {
				const view = this.ensureView();
				if (view) view.openPublishForCommand();
			},
		});

		// vault 事件：即时刷新
		this.registerEvent(
			this.app.vault.on("create", () => {
				this.invalidateDayList();
				this.scheduleRefresh();
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", () => this.scheduleRefresh())
		);
		this.registerEvent(
			this.app.vault.on("delete", () => {
				this.invalidateDayList();
				this.scheduleRefresh();
			})
		);

		// 轮询心跳兜底外部改动
		this.registerInterval(
			window.setInterval(() => this.heartbeat(), HEARTBEAT_MS)
		);

		// 窗口重新可见/获得焦点时立即做一次磁盘刷新：
		// 隐藏期间心跳会被跳过，避免切回后内容滞留
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") this.refreshViews(true);
		});
		this.registerDomEvent(window, "focus", () => this.refreshViews(true));

		// 启动时尝试打开一次（用户可从命令手动开）
		if (this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE).length) {
			this.refreshViews();
		}
	}

	onunload() {
		// 撤下挂在 body 上的主题类，避免卸载后残留影响其它插件
		const cls = document.body.classList;
		for (const name of Array.from(cls)) {
			if (name.startsWith(UI_THEME_CLASS_PREFIX)) cls.remove(name);
		}
	}

	/**
	 * 应用界面主题。挂在 body 上而非视图容器上：
	 * 回到顶部按钮、撤回提示条是 append 到 body 的，只有 body 级变量才能覆盖到它们。
	 * auto 表示不覆盖，直接跟随 Obsidian 主题与主题色。
	 */
	applyUiTheme() {
		const cls = document.body.classList;
		for (const name of Array.from(cls)) {
			if (name.startsWith(UI_THEME_CLASS_PREFIX)) cls.remove(name);
		}
		const theme = this.settings.uiTheme || "auto";
		if (theme !== "auto") cls.add(UI_THEME_CLASS_PREFIX + theme);
	}

	/** 打开或聚焦视图（中间主区域标签页） */
	async activateView() {
		// 清理被放到了侧边栏/右侧栏的旧实例，避免复用它们
		this.app.workspace
			.getLeavesOfType(MOMENT_VIEW_TYPE)
			.forEach((l) => {
				if (this.isSidebarLeaf(l)) l.detach();
			});

		// 主区域已有实例：直接聚焦，不再新开标签页
		const existing = this.app.workspace
			.getLeavesOfType(MOMENT_VIEW_TYPE)
			.find((l) => !this.isSidebarLeaf(l));
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			this.refreshViews();
			return;
		}

		// 先让活动焦点落在主工作区，再在中间取一个标签页
		let mainLeaf: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((l) => {
			if (!mainLeaf && !this.isSidebarLeaf(l)) mainLeaf = l;
		});
		if (mainLeaf) this.app.workspace.setActiveLeaf(mainLeaf);

		const leaf = this.app.workspace.getLeaf(true) as WorkspaceLeaf;
		await leaf.setViewState({
			type: MOMENT_VIEW_TYPE,
			active: true,
		});
		await this.app.workspace.revealLeaf(leaf);
		this.refreshViews();
	}

	/** 判断叶子是否位于左右侧边栏（而非中间主区域） */
	private isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
		const el = leaf.view.containerEl;
		return !!el && !!el.closest(".mod-left-split, .mod-right-split");
	}

	private ensureView(): MomentView | null {
		const leaves = this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE);
		for (const l of leaves) {
			if (l.view instanceof MomentView) return l.view;
		}
		return null;
	}

	refreshCover() {
		const v = this.ensureView();
		if (v) v.renderCoverPublic();
	}

	/** 背景文件名改动后：清空封面缓存并重绘 */
	reloadCover() {
		for (const l of this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE)) {
			if (l.view instanceof MomentView) l.view.reloadCoverPublic();
		}
	}

	/** 文字颜色等主题变量更新到所有打开的视图 */
	applyTheme() {
		for (const l of this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE)) {
			if (l.view instanceof MomentView) l.view.applyTheme();
		}
	}

	/** 将当前界面样式应用到所有已打开的视图 */
	applyStyle() {
		for (const l of this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE)) {
			if (l.view instanceof MomentView) {
				l.view.setStyleMode(this.settings.styleMode);
			}
		}
	}

	/** 图片排列模式切换：重绘信息流让新模式生效 */
	applyImageMode() {
		const v = this.ensureView();
		if (v) v.refreshPublic();
	}

	/** 汇聚的刷新调度（节流） */
	private _pending = false;
	private scheduleRefresh() {
		if (this._pending) return;
		this._pending = true;
		window.setTimeout(() => {
			this._pending = false;
			this.refreshViews();
		}, 150);
	}

	private heartbeat() {
		// 轮询兜底：库外改动可能不在 Obsidian 索引/缓存中，强制读磁盘刷新
		this.refreshViews(true);
	}

	/** 库内新增 / 删除文件：让各视图的日文件列表缓存立即失效 */
	private invalidateDayList() {
		for (const l of this.app.workspace.getLeavesOfType(MOMENT_VIEW_TYPE)) {
			if (l.view instanceof MomentView) l.view.invalidateDayList();
		}
	}

	private refreshViews(fresh = false) {
		const v = this.ensureView();
		if (v && document.visibilityState === "visible") {
			v.refreshPublic(fresh);
		}
	}

	private async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}