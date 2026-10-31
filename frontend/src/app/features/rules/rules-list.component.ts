import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RulesEngineService } from '../../core/services/rules-engine.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-rules-list',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="rules-page">
      <div class="header-row">
        <div>
          <h2>Alert Rules</h2>
          <p>Automated rules that evaluate live metrics and raise incidents.</p>
        </div>

        <!-- Requirement A6: Only operators can create/edit rules -->
        <a *ngIf="auth.isOperator()" routerLink="/rules/new" class="btn-create">
          + New Alert Rule
        </a>
      </div>

      <!-- Viewer Notice -->
      <div *ngIf="auth.isViewer()" class="viewer-banner">
        👁️ You are logged in as a <strong>Viewer</strong> (Read-only mode). Switch to <strong>Operator</strong> in the top-right to edit rules.
      </div>

      <!-- Rules List -->
      <div class="rules-list">
        <div *ngFor="let rule of rulesEngine.rules()" class="rule-card" [class.disabled-card]="!rule.enabled">
          <div class="card-top">
            <div class="rule-name-box">
              <span class="active-dot" [class.dot-on]="rule.enabled"></span>
              <h3>{{ rule.name }}</h3>
            </div>

            <!-- Operator Action buttons -->
            <div class="actions-box" *ngIf="auth.isOperator()">
              <a class="btn-toggle" [routerLink]="['/rules/edit', rule.id]">Edit</a>
              <button
                type="button"
                class="btn-toggle"
                [class.btn-on]="rule.enabled"
                (click)="rulesEngine.toggleRule(rule.id)"
              >
                {{ rule.enabled ? 'Active' : 'Paused' }}
              </button>

              <button
                type="button"
                class="btn-delete"
                (click)="rulesEngine.deleteRule(rule.id)"
                title="Delete rule"
              >
                🗑️
              </button>
            </div>
          </div>

          <div class="conditions-summary">
            <strong>Condition:</strong>
            <span *ngFor="let c of rule.conditions" class="cond-pill">
              {{ c.metric }} {{ c.operator }} {{ c.threshold }} for {{ c.durationSec }}s
            </span>
          </div>

          <div class="card-bottom">
            <span>Created: {{ rule.createdAt }}</span>
            <span *ngIf="rule.criticalThreshold">Critical: {{ rule.criticalThreshold }}</span>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .rules-page {
      max-width: 860px;
      margin: 0 auto;
      padding: 1.5rem 1rem;
      color: #e6edf3;
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.25rem;
    }
    .header-row h2 { margin: 0 0 0.25rem 0; font-size: 1.5rem; }
    .header-row p { margin: 0; color: #8b949e; font-size: 0.85rem; }

    .btn-create {
      background: #238636;
      color: white;
      text-decoration: none;
      padding: 0.5rem 0.9rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .btn-create:hover { background: #2ea043; }

    .viewer-banner {
      background: #1f6feb22;
      border: 1px solid #1f6feb66;
      color: #58a6ff;
      padding: 0.65rem 0.85rem;
      border-radius: 6px;
      margin-bottom: 1rem;
      font-size: 0.85rem;
    }

    .rules-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .rule-card {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
    }
    .rule-card.disabled-card { opacity: 0.6; }

    .card-top { display: flex; justify-content: space-between; align-items: center; }
    .rule-name-box { display: flex; align-items: center; gap: 0.5rem; }
    .active-dot { width: 8px; height: 8px; border-radius: 50%; background: #484f58; }
    .active-dot.dot-on { background: #3fb950; }
    .rule-name-box h3 { margin: 0; font-size: 1.05rem; }

    .actions-box { display: flex; gap: 0.5rem; }
    .btn-toggle {
      background: #21262d;
      border: 1px solid #30363d;
      color: #8b949e;
      padding: 0.25rem 0.6rem;
      border-radius: 4px;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .btn-toggle.btn-on { background: #0e2e1e; border-color: #238636; color: #3fb950; font-weight: 700; }
    .btn-delete {
      background: #161b22;
      border: 1px solid #30363d;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-delete:hover { background: #3c1618; border-color: #da3633; }

    .conditions-summary { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
    .cond-pill {
      background: #161b22;
      border: 1px solid #30363d;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      color: #58a6ff;
      font-size: 0.8rem;
    }

    .card-bottom {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: #8b949e;
      border-top: 1px solid #161b22;
      padding-top: 0.5rem;
    }
  `]
})
export class RulesListComponent {
  rulesEngine = inject(RulesEngineService);
  auth = inject(AuthService);
}
