import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RepoTreeNode } from '../../core/models/repo-tree.model';
import { LucideAngularModule, File, Folder, FolderOpen, ChevronRight, ChevronDown } from 'lucide-angular';

@Component({
  selector: 'app-repo-tree-node',
  standalone: true,
  imports: [CommonModule, LucideAngularModule],
  template: `
    <div class="font-mono text-sm">
      <div
        class="flex items-center py-1 px-2 hover:bg-gray-100 cursor-pointer select-none rounded"
        [class.bg-blue-50]="isSelected"
        [class.text-blue-700]="isSelected"
        (click)="onClick()"
        [style.paddingLeft.px]="level * 16 + 8"
      >
        <span class="w-4 h-4 mr-1 flex-shrink-0 text-gray-400">
          <ng-container *ngIf="node.type === 'directory'">
            <lucide-icon [name]="expanded ? 'chevron-down' : 'chevron-right'" [size]="16"></lucide-icon>
          </ng-container>
        </span>

        <span class="w-4 h-4 mr-2 flex-shrink-0" [class.text-blue-500]="node.type === 'directory'" [class.text-gray-500]="node.type === 'file'">
          <ng-container *ngIf="node.type === 'directory'">
             <lucide-icon [name]="expanded ? 'folder-open' : 'folder'" [size]="16"></lucide-icon>
          </ng-container>
          <ng-container *ngIf="node.type === 'file'">
             <lucide-icon name="file" [size]="16"></lucide-icon>
          </ng-container>
        </span>

        <span class="truncate">{{ node.name }}</span>
      </div>

      <div *ngIf="node.type === 'directory' && expanded && node.children">
        <app-repo-tree-node
          *ngFor="let child of node.children"
          [node]="child"
          [level]="level + 1"
          [selectedPath]="selectedPath"
          (fileSelected)="fileSelected.emit($event)"
        ></app-repo-tree-node>
      </div>
    </div>
  `
})
export class RepoTreeNodeComponent {
  @Input() node!: RepoTreeNode;
  @Input() level = 0;
  @Input() selectedPath: string | null = null;
  @Output() fileSelected = new EventEmitter<string>();

  expanded = false;

  readonly Folder = Folder;
  readonly FolderOpen = FolderOpen;
  readonly File = File;
  readonly ChevronRight = ChevronRight;
  readonly ChevronDown = ChevronDown;

  get isSelected(): boolean {
    return this.node.type === 'file' && this.node.path === this.selectedPath;
  }

  onClick() {
    if (this.node.type === 'directory') {
      this.expanded = !this.expanded;
    } else {
      this.fileSelected.emit(this.node.path);
    }
  }
}

@Component({
  selector: 'app-repo-tree',
  standalone: true,
  imports: [CommonModule, RepoTreeNodeComponent],
  template: `
    <div class="h-full overflow-y-auto border-r border-gray-200 bg-white pt-2">
      <app-repo-tree-node
        *ngFor="let node of tree"
        [node]="node"
        [level]="0"
        [selectedPath]="selectedPath"
        (fileSelected)="onFileSelected($event)"
      ></app-repo-tree-node>

      <div *ngIf="!tree || tree.length === 0" class="p-4 text-gray-500 text-sm italic text-center">
        No files to display.
      </div>
    </div>
  `
})
export class RepoTreeComponent {
  @Input() tree: RepoTreeNode[] = [];
  @Input() selectedPath: string | null = null;
  @Output() fileSelected = new EventEmitter<string>();

  onFileSelected(path: string) {
    this.fileSelected.emit(path);
  }
}
