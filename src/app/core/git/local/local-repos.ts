import { Injectable } from '@angular/core';

import { RepoProviderError } from '../../models';
import { FsLike, createFsaFs } from './fsa-fs';

const DB_NAME = 'time-tracer';
const STORE = 'local-repos';

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?(options?: { mode?: string }): Promise<FileSystemDirectoryHandle>;
}

/** Permission methods are not yet in the standard DOM typings. */
interface PermissionedHandle extends FileSystemDirectoryHandle {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** Whether this browser can open local folders (File System Access API). */
export function supportsLocalRepos(): boolean {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

/**
 * Registry of locally opened repositories: maps a repo name to the fs the
 * git provider reads from. Directory handles are persisted in IndexedDB
 * (they survive reloads), but re-reading after a reload needs the user to
 * re-grant permission — `reconnect` does that from a user gesture.
 */
@Injectable({ providedIn: 'root' })
export class LocalRepos {
  private readonly fsByName = new Map<string, FsLike>();

  /** Registers an fs directly — the local provider reads through this. */
  register(name: string, fs: FsLike): void {
    this.fsByName.set(name, fs);
  }

  fsFor(name: string): FsLike {
    const fs = this.fsByName.get(name);
    if (!fs) {
      throw new RepoProviderError(
        `The local folder "${name}" is not connected — its permission does not survive a reload. Use "Reconnect folder" or pick it again from the start page.`,
        'not-found',
      );
    }
    return fs;
  }

  isConnected(name: string): boolean {
    return this.fsByName.has(name);
  }

  /**
   * Opens the directory picker and registers the chosen repository.
   * Resolves with the repo name, or null when the user cancelled.
   * Rejects when the folder does not contain a `.git` directory.
   */
  async pick(): Promise<string | null> {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      throw new Error('This browser does not support opening local folders.');
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await picker.call(window, { mode: 'read' });
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return null;
      throw error;
    }
    try {
      await handle.getDirectoryHandle('.git');
    } catch {
      throw new Error(`"${handle.name}" does not look like a git repository (no .git folder).`);
    }
    this.fsByName.set(handle.name, createFsaFs(handle));
    void this.persistHandle(handle.name, handle);
    return handle.name;
  }

  /**
   * Restores a persisted handle after a reload and re-requests permission.
   * Must be called from a user gesture. Resolves true when reading works.
   */
  async reconnect(name: string): Promise<boolean> {
    const handle = (await this.loadHandle(name)) as PermissionedHandle | null;
    if (!handle) return false;
    const query = await handle.queryPermission?.({ mode: 'read' });
    if (query !== 'granted') {
      const granted = await handle.requestPermission?.({ mode: 'read' });
      if (granted !== 'granted') return false;
    }
    this.fsByName.set(name, createFsaFs(handle));
    return true;
  }

  /** Whether a handle for `name` is persisted (reconnect could work). */
  async hasStoredHandle(name: string): Promise<boolean> {
    return (await this.loadHandle(name)) !== null;
  }

  private async persistHandle(name: string, handle: FileSystemDirectoryHandle): Promise<void> {
    try {
      const db = await this.openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(handle, name);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      // IndexedDB unavailable — handles simply won't survive reloads.
    }
  }

  private async loadHandle(name: string): Promise<FileSystemDirectoryHandle | null> {
    try {
      const db = await this.openDb();
      const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(name);
        request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle) ?? null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return handle;
    } catch {
      return null;
    }
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
