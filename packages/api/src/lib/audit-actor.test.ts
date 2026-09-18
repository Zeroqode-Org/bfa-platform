import { describe, expect, it } from "vitest";

import { auditActor, auditActorFields } from "./audit-actor";

const superAdmin = "5a000000-0000-4000-8000-000000000001";
const wpAdmin = "a0000000-0000-4000-8000-000000000001";

describe("auditActor", () => {
	it("attributes an impersonated action to the real Super-Admin", () => {
		const actor = auditActor({
			actor: { profileId: superAdmin },
			caller: { profileId: wpAdmin },
		});

		expect(auditActorFields(actor)).toEqual({
			actor_id: superAdmin,
			effective_profile_id: wpAdmin,
		});
	});

	it("names the same account twice outside impersonation", () => {
		expect(
			auditActorFields(
				auditActor({
					actor: { profileId: wpAdmin },
					caller: { profileId: wpAdmin },
				}),
			),
		).toEqual({ actor_id: wpAdmin, effective_profile_id: wpAdmin });
	});

	it("records unknown attribution as null rather than omitting it", () => {
		expect(auditActorFields(undefined)).toEqual({
			actor_id: null,
			effective_profile_id: null,
		});
	});
});
