import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RulesEngineService } from '../../../core/services/rules-engine.service';

@Component({
  selector: 'app-toast-notifications',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="rulesEngine.currentNotification() as msg" class="toast-popup">
      <span>{{ msg }}</span>
      <button (click)="rulesEngine.currentNotification.set(null)">✕</button>
    </div>
  `,
  styles: [`
    .toast-popup {
      position: fixed;
      bottom: 1.25rem;
      right: 1.25rem;
      background: #1f6feb;
      color: white;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
      z-index: 9999;
    }
    button {
      background: transparent;
      border: none;
      color: white;
      cursor: pointer;
      font-size: 0.9rem;
    }
  `]
})
export class ToastNotificationsComponent {
  rulesEngine = inject(RulesEngineService);
}
