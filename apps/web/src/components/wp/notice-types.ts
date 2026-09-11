import type { AppRouter } from "@bfa-platform/api/routers/index";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type RouterInputs = inferRouterInputs<AppRouter>;

/** One entry of `notices.listNoticeTemplates` — always one per notice type. */
export type NoticeTemplate =
	RouterOutputs["notices"]["listNoticeTemplates"][number];

/**
 * The field set `upsertNoticeTemplate` takes. Derived from the router rather
 * than retyped, so the editor has to satisfy the same shape the server
 * validates — a field renamed on one side stops compiling on the other.
 */
export type NoticeTemplatePayload =
	RouterInputs["notices"]["upsertNoticeTemplate"];

export type BroadcastPayload =
	RouterInputs["notices"]["sendGeneralInfoBroadcast"];

export type BroadcastAudience =
	RouterOutputs["notices"]["getBroadcastAudience"];

/**
 * The sample values a preview substitutes. Keyed by variable name, so adding a
 * seventh variable does not widen this type by hand.
 */
export type NoticeSampleValues =
	RouterOutputs["notices"]["getNoticePreviewSample"]["values"];
