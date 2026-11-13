import { publicProcedure, router } from "../index";
import {
	CONTACT_INQUIRY_RECIPIENT,
	contactInquiryInput,
	contactInquirySubject,
	isLikelyBot,
	renderContactInquiryEmail,
} from "../lib/contact-inquiry";
import { sendEmail } from "../lib/email";

export const contactRouter = router({
	/**
	 * The landing page's Contact Us form. Public: the people filling it in have
	 * no account yet.
	 *
	 * The inquiry is mailed to the Backflow Reporter inbox and stored nowhere.
	 * A failed send propagates — the visitor is told it did not go through
	 * rather than thanked for a message nobody will read.
	 *
	 * A filled honeypot is answered exactly like a real inquiry and dropped, so
	 * a bot learns nothing from the response.
	 */
	submit: publicProcedure
		.input(contactInquiryInput)
		.mutation(async ({ input }) => {
			if (isLikelyBot(input)) {
				console.log(
					JSON.stringify({
						event: "contact_inquiry_dropped",
						reason: "honeypot",
						// Kept so a real inquiry caught by mistake can still be answered.
						sender_email: input.email,
						timestamp: new Date().toISOString(),
					}),
				);

				return { sent: true };
			}

			await sendEmail(
				{
					to: CONTACT_INQUIRY_RECIPIENT,
					subject: contactInquirySubject(input),
					html: renderContactInquiryEmail(input),
					tags: [{ name: "category", value: "contact_inquiry" }],
				},
				{ event: "contact_inquiry" },
			);

			return { sent: true };
		}),
});
