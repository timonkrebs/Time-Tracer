import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-repo-url-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="max-w-2xl w-full mx-auto p-6 bg-white rounded-lg shadow-md border border-gray-200">
      <h2 class="text-2xl font-bold mb-4 text-gray-800">Load Git Repository</h2>

      <form (ngSubmit)="onSubmit()" class="flex flex-col gap-4">
        <div>
          <label for="url" class="block text-sm font-medium text-gray-700 mb-1">Repository URL</label>
          <input
            type="text"
            id="url"
            name="url"
            [(ngModel)]="url"
            placeholder="e.g., https://github.com/angular/angular"
            class="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 outline-none"
            required
          >
        </div>

        <button
          type="submit"
          class="bg-blue-600 text-white font-medium py-2 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
          [disabled]="!url"
        >
          Load Repository
        </button>
      </form>

      <div class="mt-6 text-sm text-gray-500">
        <p>Examples:</p>
        <ul class="list-disc list-inside mt-2 space-y-1">
          <li><button (click)="setUrl('https://github.com/angular/angular')" class="text-blue-600 hover:underline">https://github.com/angular/angular</button></li>
          <li><button (click)="setUrl('https://github.com/microsoft/vscode')" class="text-blue-600 hover:underline">https://github.com/microsoft/vscode</button></li>
        </ul>
      </div>
    </div>
  `
})
export class RepoUrlFormComponent {
  url = '';

  @Output() loadRequested = new EventEmitter<string>();

  onSubmit() {
    if (this.url) {
      this.loadRequested.emit(this.url);
    }
  }

  setUrl(example: string) {
    this.url = example;
  }
}