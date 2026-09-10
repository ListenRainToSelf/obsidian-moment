import { App, TFile, normalizePath } from "obsidian";
import type { MomentSettings } from "./settings";
import type { AggregationLevel, MomentDay } from "./types";
import { DayFileStore } from "./dayFile";
import { monthBodyDir, attachmentRoot } from "./paths";
import { dateParts } from "./settings";

/**
 * 下拉全览：把多日的动态聚合成按 天 / 周 / 月 / 年 的相册式分组。
 */
export class OverviewBuilder {
	private store: DayFileStore;

	constructor(private app: App, private settings: MomentSettings) {
		this.store = new DayFileStore(app, settings);
	}

	/**
	 * 生成聚合分组。
	 * @param level 聚合粒度
	 * @param lastN 向过去回溯的单位数（日/周/月/年）
	 */
	async build(
		level: AggregationLevel,
		lastN: number = 8
	): Promise<OverviewUnit[]> {
		// 枚举需要读取的日期
		const dateDays = this.datesFor(level, lastN);
		const units: OverviewUnit[] = [];

		if (level === "day") {
			for (const d of dateDays) {
				const day = await this.store.readDay(d);
				if (!day || (!day.messages.length && !day.thumbs.length))
					continue;
				units.push({
					key: day.date,
					_label: labelFor(level, d),
					day,
				});
			}
		} else {
			// 周/月/年：聚合 days
			const grouped = new Map<string, MomentDay[]>();
			for (const d of dateDays) {
				const day = await this.store.readDay(d);
				if (!day || (!day.messages.length && !day.thumbs.length))
					continue;
				const key = groupKey(level, d);
				const arr = grouped.get(key) || [];
				arr.push(day);
				grouped.set(key, arr);
			}
			// 展平成 units（按 key 排序）
			const sortedKeys = [...grouped.keys()].sort();
			for (const key of sortedKeys) {
				const days = grouped.get(key)!;
				units.push({
					key,
					_label: key,
					days,
					thumbCount: days.reduce(
						(n, d) => n + d.thumbs.length,
						0
					),
				});
			}
		}
		return units;
	}

	/** 附件资源路径解析（供缩略图） */
	thumbUri(fileRef: string): string {
		return this.app.vault.getResourcePath(
			this.app.vault.getAbstractFileByPath(
				normalizePath(fileRef)
			) as TFile
		);
	}

	/** 生成待扫描日期 */
	private datesFor(level: AggregationLevel, lastN: number): Date[] {
		const now = new Date();
		const today = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate()
		);
		const dates: Date[] = [];
		const seen = new Set<string>();
		const count = Math.max(lastN * (level === "day" ? 1 : 7), lastN);
		for (let i = 0; i < count * 8; i++) {
			const d = new Date(today);
			d.setDate(today.getDate() - i);
			const key =
				level === "day"
					? dateParts(d).dateKey
					: groupKey(level, d);
			if (level === "day") {
				dates.push(d);
				if (dates.length >= lastN) break;
			} else {
				if (!seen.has(key)) {
					seen.add(key);
					dates.push(d); // 该组首个样本日
					if (seen.size >= lastN) break;
				}
			}
		}
		return dates;
	}

	/** 附件根（供外部位图） */
	get attachmentRoot() {
		return attachmentRoot(this.settings);
	}
}

export interface OverviewUnit {
	key: string;
	_label: string;
	day?: MomentDay;
	days?: MomentDay[];
	thumbCount?: number;
}

function groupKey(level: Exclude<AggregationLevel, "day">, d: Date): string {
	const p = dateParts(d);
	switch (level) {
		case "week": {
			// 取周一为一周起点
			const weekday = d.getDay() || 7;
			const monday = new Date(d);
			monday.setDate(d.getDate() - (weekday - 1));
			const mp = dateParts(monday);
			return `${d.getFullYear()}-W` + pad(mondayWeek(monday));
		}
		case "month":
			return `${p.monthDir}`;
		case "year":
			return `${d.getFullYear()}`;
	}
	return "";
}
function mondayWeek(d: Date): number {
	const jan1 = new Date(d.getFullYear(), 0, 1);
	const week = Math.ceil(
		((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7
	);
	return week;
}
function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function labelFor(_l: AggregationLevel, d: Date): string {
	const p = dateParts(d);
	return `${p.day} · ${p.month}月`;
}