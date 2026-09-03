/**
 * Fixture rows for the Super-Admin water-purveyor list. Week 1 is UI only — the
 * Week 4 `listWaterPurveyors` procedure returns this same shape (plus the
 * per-WP feature flags), so the table swaps its source without changing.
 * Nothing outside the Super-Admin screens reads this file.
 */
export type WaterPurveyorRow = {
	id: string;
	company: string;
	contact: string;
	assets: number;
	certifiers: number;
	submissions: number;
	status: "active" | "blocked";
};

/** Companies and contacts carried over from the approved click-through prototype. */
export const waterPurveyorFixtures: WaterPurveyorRow[] = [
	{
		id: "wp-riverside",
		company: "Riverside Water District",
		contact: "Priya Anand",
		assets: 1284,
		certifiers: 6,
		submissions: 947,
		status: "active",
	},
	{
		id: "wp-coastal-valley",
		company: "Coastal Valley Utilities",
		contact: "Marcus Ellery",
		assets: 763,
		certifiers: 4,
		submissions: 512,
		status: "active",
	},
	{
		id: "wp-highland",
		company: "Highland Municipal Water",
		contact: "Sofia Ramos",
		assets: 431,
		certifiers: 3,
		submissions: 268,
		status: "active",
	},
	{
		id: "wp-desert-springs",
		company: "Desert Springs Water Co.",
		contact: "Ben Okafor",
		assets: 96,
		certifiers: 2,
		submissions: 34,
		status: "blocked",
	},
	{
		id: "wp-north-fork",
		company: "North Fork Regional Water",
		contact: "Elena Petrova",
		assets: 8,
		certifiers: 1,
		submissions: 0,
		status: "active",
	},
];
