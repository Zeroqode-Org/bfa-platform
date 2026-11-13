/**
 * Field limits for the landing page's Contact Us inquiry. Kept apart from
 * `contact-inquiry.ts` so the client form can import them without pulling the
 * email renderer into the browser bundle.
 */
export const CONTACT_INQUIRY_LIMITS = {
	name: 120,
	organization: 160,
	email: 254,
	message: 4000,
} as const;
