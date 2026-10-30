/**
 * The password rule for every screen that sets one: the first-login form, the
 * server action behind it, and the certifier's change-password card.
 *
 * At least eight characters, with a lowercase letter, a capital letter, a digit
 * and a symbol — the client's "industry-standard" ask, widened to match
 * Supabase Auth's strictest "Password Requirements" setting (lowercase,
 * uppercase, digits and symbols), which is what enforces it on the server.
 * Matching it exactly matters: a password this rule accepted and Supabase then
 * refused would surface as Supabase's own error instead of the hint below. One
 * function rather than a rule per screen, so the form's inline message, the
 * action's refusal and the profile card's toast cannot drift apart.
 *
 * It only governs passwords set from now on: sign-in never checks it, so an
 * existing account with a weaker password keeps working.
 */

export const MIN_PASSWORD_LENGTH = 8;

/** What the screens print under the password box. */
export const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters, with a lowercase letter, a capital letter, a number and a symbol.`;

const LOWERCASE = /[a-z]/;
const CAPITAL = /[A-Z]/;
const DIGIT = /[0-9]/;
// Supabase Auth's own symbol set, character for character, so a symbol it
// does not count (`€`, a space) is not counted here either.
const SYMBOL = /[!@#$%^&*()_+\-=[\]{};'\\:"|<>?,./`~]/;

/** The first thing the password is missing, or `undefined` when it passes. */
export function passwordPolicyError(password: string): string | undefined {
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	if (!LOWERCASE.test(password)) {
		return "Include at least one lowercase letter.";
	}
	if (!CAPITAL.test(password)) {
		return "Include at least one capital letter.";
	}
	if (!DIGIT.test(password)) {
		return "Include at least one number.";
	}
	if (!SYMBOL.test(password)) {
		return "Include at least one symbol, such as ! ? # or @.";
	}

	return undefined;
}
