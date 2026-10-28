/**
 * The password rule for every screen that sets one: the first-login form, the
 * server action behind it, and the certifier's change-password card.
 *
 * At least eight characters, one capital letter and one special character —
 * the client's "industry-standard" ask. One function rather than a rule per
 * screen, so the form's inline message, the action's refusal and the profile
 * card's toast cannot drift apart.
 *
 * It only governs passwords set from now on: sign-in never checks it, so an
 * existing account with a weaker password keeps working.
 */

export const MIN_PASSWORD_LENGTH = 8;

/** What the screens print under the password box. */
export const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters, with a capital letter and a special character.`;

const CAPITAL = /[A-Z]/;
// Anything that is not a letter, a digit or whitespace — `!`, `#`, `_`, `€`.
const SPECIAL = /[^\p{L}\p{N}\s]/u;

/** The first thing the password is missing, or `undefined` when it passes. */
export function passwordPolicyError(password: string): string | undefined {
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	if (!CAPITAL.test(password)) {
		return "Include at least one capital letter.";
	}
	if (!SPECIAL.test(password)) {
		return "Include at least one special character, such as ! ? # or @.";
	}

	return undefined;
}
