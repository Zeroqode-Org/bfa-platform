import { describe, expect, it, vi } from "vitest";

import {
	readVerifiedAuthSession,
	sessionIdFromAccessToken,
} from "./auth-session";

/**
 * The verified auth-session id the impersonation cookie is bound to. What
 * matters is where the id comes from: only from a token the Auth server has
 * just accepted, and only when that token belongs to the user it returned.
 */

const USER_ID = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const OTHER_USER_ID = "7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b";
const SESSION_ID = "5e55a000-0000-4000-8000-00000000000a";

function jwt(payload: Record<string, unknown>) {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.not-checked-here`;
}

function clientWith({
	accessToken,
	acceptedBy = true,
	userId = USER_ID,
}: {
	accessToken: string | null;
	acceptedBy?: boolean;
	userId?: string;
}) {
	const getUser = vi.fn(async (_token?: string) =>
		acceptedBy
			? { data: { user: { id: userId } }, error: null }
			: { data: { user: null }, error: new Error("invalid JWT") },
	);
	const client = {
		auth: {
			getSession: async () => ({
				data: {
					session: accessToken ? { access_token: accessToken } : null,
				},
				error: null,
			}),
			getUser,
		},
	};
	return { client: client as never, getUser };
}

describe("readVerifiedAuthSession", () => {
	it("returns the user and the session id of the token the Auth server accepted", async () => {
		const token = jwt({ sub: USER_ID, session_id: SESSION_ID });
		const { client, getUser } = clientWith({ accessToken: token });

		await expect(readVerifiedAuthSession(client)).resolves.toEqual({
			user: { id: USER_ID },
			sessionId: SESSION_ID,
		});
		// Exactly the token the session id is read from is the one verified.
		expect(getUser).toHaveBeenCalledWith(token);
	});

	it("is signed out when there is no session", async () => {
		const { client, getUser } = clientWith({ accessToken: null });

		await expect(readVerifiedAuthSession(client)).resolves.toEqual({
			user: null,
			sessionId: null,
		});
		expect(getUser).not.toHaveBeenCalled();
	});

	it("trusts nothing from a token the Auth server refused, however plausible its claims", async () => {
		const forged = jwt({ sub: USER_ID, session_id: SESSION_ID });
		const { client } = clientWith({ accessToken: forged, acceptedBy: false });

		await expect(readVerifiedAuthSession(client)).resolves.toEqual({
			user: null,
			sessionId: null,
		});
	});

	it("keeps the user but no session id when the token's subject is somebody else", async () => {
		const { client } = clientWith({
			accessToken: jwt({ sub: OTHER_USER_ID, session_id: SESSION_ID }),
		});

		await expect(readVerifiedAuthSession(client)).resolves.toEqual({
			user: { id: USER_ID },
			sessionId: null,
		});
	});
});

describe("sessionIdFromAccessToken", () => {
	it.each([
		["no payload", "header-only"],
		["not base64 JSON", "a.%%%.c"],
		["no session_id", jwt({ sub: USER_ID })],
		["an empty session_id", jwt({ sub: USER_ID, session_id: "" })],
		["a non-string session_id", jwt({ sub: USER_ID, session_id: 42 })],
	])("returns null for %s", (_label, token) => {
		expect(sessionIdFromAccessToken(token, USER_ID)).toBeNull();
	});
});
