/**
 * Whether the results document — the PDF and the wizard's preview of it —
 * prints the water purveyor's address under its name.
 *
 * Off for now (client, October 2026): purveyors' addresses are not filled in
 * yet, so the header shows the name and the PWSID only. Pure, no DB or PDF
 * import, so the web preview and the PDF read the same switch.
 */
export const SHOW_WP_ADDRESS_ON_DOCUMENT = false;
