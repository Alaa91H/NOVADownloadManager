export type SecretString = string & { readonly __secret: unique symbol };
export function asSecret(value: string): SecretString { return value as SecretString; }
