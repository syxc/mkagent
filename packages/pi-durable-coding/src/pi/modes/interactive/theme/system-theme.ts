// Use the terminal palette; this host does not request terminal color reports.

import type { ThemeAppearance, ThemeBg, ThemeColor, ThemeToken } from "./theme.ts";

export const SYSTEM_THEME_NAME = "system";

const FAMILY_SLOTS = {
	neutral: 8,
	blue: 4,
	green: 2,
	red: 1,
	yellow: 3,
	orange: 3,
	violet: 5,
	calamine: 6,
	thinkingSlate: 4,
	thinkingBlue: 4,
	thinkingPeriwinkle: 6,
	thinkingViolet: 5,
	thinkingMagenta: 13,
	thinkingRed: 1,
} as const;

type FamilyName = keyof typeof FAMILY_SLOTS;

const TOKEN_FAMILIES: Record<ThemeToken, FamilyName> = {
	selectedBg: "blue",
	searchMatchBg: "orange",
	userMessageBg: "blue",
	customMessageBg: "violet",
	toolPendingBg: "neutral",
	toolSuccessBg: "green",
	toolErrorBg: "red",

	text: "neutral",
	userMessageText: "neutral",
	customMessageText: "neutral",
	toolTitle: "neutral",
	syntaxOperator: "neutral",
	syntaxPunctuation: "neutral",
	muted: "neutral",
	dim: "neutral",
	thinkingText: "neutral",
	toolOutput: "neutral",
	mdLinkUrl: "neutral",
	mdQuote: "neutral",
	mdQuoteBorder: "neutral",
	mdHr: "neutral",
	mdCodeBlockBorder: "neutral",
	toolDiffContext: "neutral",
	syntaxComment: "neutral",
	scrollbarTrack: "neutral",
	scrollbarThumb: "neutral",
	searchMatchText: "neutral",
	borderMuted: "neutral",

	accent: "violet",
	borderAccent: "violet",
	customMessageLabel: "violet",
	mdCode: "violet",
	mdListBullet: "violet",
	syntaxType: "violet",
	border: "blue",
	mdLink: "blue",
	syntaxKeyword: "blue",
	syntaxVariable: "calamine",
	success: "green",
	mdCodeBlock: "green",
	toolDiffAdded: "green",
	bashMode: "green",
	syntaxNumber: "green",
	error: "red",
	toolDiffRemoved: "red",
	warning: "yellow",
	mdHeading: "yellow",
	syntaxFunction: "yellow",
	syntaxString: "orange",

	thinkingOff: "neutral",
	thinkingMinimal: "thinkingSlate",
	thinkingLow: "thinkingBlue",
	thinkingMedium: "thinkingPeriwinkle",
	thinkingHigh: "thinkingViolet",
	thinkingXhigh: "thinkingMagenta",
	thinkingMax: "thinkingRed",
};

const TOKEN_SLOTS: Partial<Record<ThemeToken, number>> = { syntaxString: 2, syntaxNumber: 5, searchMatchBg: 3 };

const PANELS: ThemeBg[] = [
	"userMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"selectedBg",
	"searchMatchBg",
	"customMessageBg",
];

const FOREGROUND_TOKENS: ThemeColor[] = ["text", "userMessageText", "toolTitle"];

export interface SystemThemeColors {
	/** Hex colors, ANSI palette indices, or "" for the terminal default. */
	colors: Record<ThemeToken, string | number>;
	/** Foreground tokens rendered faint (SGR 2), for terminals that did not report colors. */
	dim: ThemeColor[];
	appearance: ThemeAppearance | undefined;
}

export function generateSystemThemeColors(appearance: ThemeAppearance): SystemThemeColors {
	const colors = {} as Record<ThemeToken, string | number>;
	const dim: ThemeColor[] = [];
	for (const [token, familyName] of Object.entries(TOKEN_FAMILIES) as [ThemeToken, FamilyName][]) {
		if (PANELS.includes(token as ThemeBg)) {
			colors[token] = "";
			continue;
		}
		const neutral = familyName === "neutral";
		colors[token] = !neutral ? (TOKEN_SLOTS[token] ?? FAMILY_SLOTS[familyName]) : "";
		if (neutral && !FOREGROUND_TOKENS.includes(token as ThemeColor)) dim.push(token as ThemeColor);
	}
	return { colors, dim, appearance };
}
