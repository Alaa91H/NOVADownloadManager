import { TokenStore } from '../storage/token-store';

export class AuthManager {
  constructor(private readonly tokens = new TokenStore()) {}

  getToken(): Promise<string | undefined> {
    return this.tokens.get();
  }

  setToken(token: string, ttlSeconds?: number): Promise<void> {
    return this.tokens.set(token, ttlSeconds);
  }

  tokenStatus() {
    return this.tokens.status();
  }

  clear(): Promise<void> {
    return this.tokens.clear();
  }
}
