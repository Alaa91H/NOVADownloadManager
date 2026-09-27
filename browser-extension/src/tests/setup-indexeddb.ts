// Provides a spec-compliant in-memory IndexedDB so Dexie-backed stores (outbox,
// candidate cache) can be unit-tested under jsdom, which has no IndexedDB.
import 'fake-indexeddb/auto';
