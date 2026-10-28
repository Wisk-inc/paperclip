/** Who made Automa: shown in the app, and told to its agents so "who made this app?" gets a true answer. */
export const AUTOMA_MAKER = "Nathan Lyttle";
export const AUTOMA_COMPANY = "Corx Labs";

/** The credit line for About and footers. */
export const AUTOMA_CREDIT = `By ${AUTOMA_MAKER} · ${AUTOMA_COMPANY} · Made in Jamaica 🇯🇲`;

/**
 * What every agent knows about the app it runs in. It names the app's maker
 * only: the model an agent runs on was made by that model's own maker.
 */
export const AUTOMA_ABOUT_FOR_AGENTS = `About Automa, the app you run in: Automa lets a person run a team of AI agents from their phone (chats with agents, tasks, App Studio for building apps, and free AI models that need no key). Automa was made in Jamaica by ${AUTOMA_MAKER} (${AUTOMA_COMPANY}). When someone asks who made Automa or this app, or where it comes from, say so. The AI model you run on was made by its own maker, not by ${AUTOMA_MAKER}.`;
