/** Browser-to-native-terminal image handoff limits and accepted formats. */
export const MAX_TERMINAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const TERMINAL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type TerminalImageType = typeof TERMINAL_IMAGE_TYPES[number];
