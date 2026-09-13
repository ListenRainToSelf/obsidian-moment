import { DayFileStore } from "./dayFile";
import type { AggregationLevel, MomentDay } from "./types";
import { dateParts } from "./settings";

/**
 * 下拉全览：把多日的动态聚合成按 天 / 周 / 月 / 年 的相册式分组。
 * 复用视图的 DayFileStore，使全览与信息流 / 活跃度共享读盘与解析缓存。
 */
export class OverviewBuilder {
	constructor(private store: DayFileStore) {}

	/**
	 * 生成聚合分组。
	 * @param level 聚合粒度
	 * @param lastN 向过去回溯的单位数（日/周/月/年）
	 */
	async build(
		level: AggregationLevel,
		lastN: number = 8
	): Promise<OverviewUnit[]> {
		const dateDays = this.datesFor(level, lastN);
		// 并行读取 + 过滤空天，保留原日期顺序
		const loaded = await Promise.all(
			dateDays.map((d) => this.store.readDay(d))
		);
		const pairs: { date: Date; day: MomentDay }[] = [];
		loaded.forEach((day, i) => {
			if (!day || (!day.messages.length && !day.thumbs.length)) return;
			pairs.push({ date: dateDays[i], day });
		});

		if (level === "day") {
			return pairs.map(({ date, day }) => ({
				key: day.date,
				_label: labelFor(date),
				day,
			}));
		}

		// 周 / 月 / 年：先按 key 聚合，再按 key 排序展平
		const grouped = new Map<string, MomentDay[]>();
		for (const { date, day } of pairs) {
			const key = groupKey(level, date);
			const arr = grouped.get(key) || [];
			arr.push(day);
			grouped.set(key, arr);
		}
		return [...grouped.keys()].sort().map((key) => {
			const days = grouped.get(key)!;
			return {
				key,
				_label: key,
				days,
				thumbCount: days.reduce((n, d) => n + d.thumbs.length, 0),
			};
		});
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

function labelFor(d: Date): string {
	const p = dateParts(d);
	return `${p.day} · ${p.month}月`;
}
