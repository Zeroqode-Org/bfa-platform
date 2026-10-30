/**
 * The first-login form's limits, shared by the server action that enforces
 * them and the form that reports them inline before submitting.
 *
 * Its own module because a `"use server"` file may only export async functions,
 * so the action cannot export these itself.
 */
export const REDEEM_FIELD_LIMITS = {
	fullName: 200,
	password: 200,
	certifierCompany: 200,
	certifierIdNumber: 100,
} as const;
