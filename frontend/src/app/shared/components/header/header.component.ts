import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { MetricsStreamService } from '../../../core/services/metrics-stream.service';
import { RulesEngineService } from '../../../core/services/rules-engine.service';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  template: `
    <header class="app-header">
      <!-- Left side: Brand and Links -->
      <div class="left-section">
        <a routerLink="/services" class="logo">
          <span class="logo-icon">⚡</span>
          <span class="brand-title">Fleet Pulse</span>
        </a>

        <nav class="nav-links">
          <a routerLink="/services" routerLinkActive="active" class="nav-link">
            Fleet Table
          </a>

          <!-- Requirement A6: Viewers cannot access /rules -->
          <a
            routerLink="/rules"
            routerLinkActive="active"
            class="nav-link"
            [class.disabled]="auth.isViewer()"
            [title]="auth.isViewer() ? 'Restricted to operators only' : 'Configure Alert Rules'"
          >
            Alert Rules
            <span *ngIf="auth.isViewer()" class="tag-viewer">Operator Only</span>
          </a>

          <a routerLink="/settings" routerLinkActive="active" class="nav-link">
            Settings
          </a>
        </nav>
      </div>

      <!-- Right side: Connection Health, Chaos Switches & User Role -->
      <div class="right-section">
        <!-- Live Connection Health Indicator (Requirement E1) -->
        <div class="status-pill" [ngClass]="getPillClass()" role="status" aria-live="polite" aria-atomic="true">
          <span class="dot"></span>
          <span>{{ getStatusText() }}</span>
          <span *ngIf="stream.connectionStatus() === 'Live'" class="rate">
            {{ stream.eventsPerSecond() }} evt/s
          </span>
        </div>

        <!-- Chaos Failure Drill button -->
        <button type="button" class="btn-chaos" (click)="toggleChaosMenu()">
          🛠️ Chaos Drills
        </button>

        <!-- Current User Role & Quick Switch -->
        <div class="user-box">
          <span class="user-role-badge" [class.badge-op]="auth.isOperator()">
            {{ auth.currentUser()?.role | uppercase }}
          </span>

          <button type="button" class="btn-logout" (click)="auth.logout()">
            Logout
          </button>
        </div>
      </div>
    </header>

    <!-- Chaos Testing Menu Modal -->
    <div
      *ngIf="showChaosModal()"
      class="chaos-backdrop"
      role="presentation"
      tabindex="0"
      (click)="closeChaosMenuOnBackdrop($event)"
      (keydown.enter)="closeChaosMenuOnBackdrop($event)"
      (keydown.space)="closeChaosMenuOnBackdrop($event)"
    >
      <div class="chaos-card">
        <h3>🛠️ Test Chaos Switches & Fallbacks</h3>
        <p>Use these buttons to easily test how the app handles network drops and recovery:</p>

        <div class="chaos-group">
          <p class="group-label">1. Transport Protocol:</p>
          <div class="btn-row">
            <button
              [class.active]="stream.activeTransport() === 'WebSocket'"
              (click)="stream.setTransport('WebSocket')"
            >WebSocket</button>
            <button
              [class.active]="stream.activeTransport() === 'SSE'"
              (click)="stream.setTransport('SSE')"
            >SSE</button>
            <button
              [class.active]="stream.activeTransport() === 'Polling'"
              (click)="stream.setTransport('Polling')"
            >Polling</button>
          </div>
        </div>

        <div class="chaos-group">
          <p class="group-label">2. Failure Drills:</p>
          <div class="drill-list">
            <button (click)="stream.simulateFailure('ws-fail')">💥 Drop WebSocket (Falls to SSE)</button>
            <button (click)="stream.simulateFailure('sse-fail')">💥 Drop SSE (Falls to Polling)</button>
            <button (click)="stream.simulateFailure('stale')">⏳ Simulate Stale (&gt;10s idle)</button>
            <button (click)="stream.simulateFailure('offline')">🔌 Simulate Browser Offline</button>
            <button class="btn-restore" (click)="stream.recoverHealthy()">✅ Restore Healthy Stream</button>
          </div>
        </div>

        <button class="btn-close" (click)="toggleChaosMenu()">Close</button>
      </div>
    </div>
  `,
  styles: [`
    .app-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 1.25rem;
      height: 56px;
      background: #0d1117;
      border-bottom: 1px solid #21262d;
      color: #e6edf3;
      user-select: none;
    }

    .left-section, .right-section {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      text-decoration: none;
      color: inherit;
      font-weight: 800;
      font-size: 1.1rem;
    }
    .logo-icon { color: #58a6ff; font-size: 1.3rem; }

    .nav-links {
      display: flex;
      gap: 0.5rem;
      margin-left: 0.75rem;
    }

    .nav-link {
      padding: 0.35rem 0.65rem;
      border-radius: 6px;
      color: #8b949e;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .nav-link:hover:not(.disabled) { color: #fff; background: #161b22; }
    .nav-link.active { color: #58a6ff; background: #1f6feb22; }
    .nav-link.disabled { opacity: 0.5; cursor: not-allowed; }

    .tag-viewer {
      font-size: 0.65rem;
      background: #30363d;
      color: #8b949e;
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      margin-left: 0.3rem;
    }

    /* Status Pill */
    .status-pill {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.7rem;
      border-radius: 16px;
      font-size: 0.8rem;
      font-weight: 600;
      border: 1px solid #30363d;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; }

    .pill-live { background: #0e2e1e; border-color: #238636; color: #3fb950; }
    .pill-live .dot { background: #3fb950; }

    .pill-reconnecting { background: #351b08; border-color: #bd561d; color: #f0883e; }
    .pill-reconnecting .dot { background: #f0883e; animation: blink 1s infinite; }

    .pill-stale { background: #3c1618; border-color: #da3633; color: #f85149; }
    .pill-stale .dot { background: #f85149; }

    .pill-offline { background: #21262d; border-color: #484f58; color: #8b949e; }
    .pill-offline .dot { background: #8b949e; }

    @keyframes blink { 50% { opacity: 0.2; } }

    .rate { font-family: monospace; font-size: 0.75rem; opacity: 0.85; margin-left: 0.2rem; }

    .btn-chaos, .btn-switch, .btn-logout {
      background: #21262d;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 0.3rem 0.6rem;
      border-radius: 6px;
      font-size: 0.75rem;
      cursor: pointer;
    }
    .btn-chaos:hover, .btn-switch:hover, .btn-logout:hover { background: #30363d; color: #fff; }

    .user-box { display: flex; align-items: center; gap: 0.5rem; }
    .user-role-badge {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.2rem 0.45rem;
      border-radius: 4px;
      background: #21262d;
      color: #8b949e;
    }
    .badge-op { background: #1f6feb; color: #fff; }

    /* Modal */
    .chaos-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .chaos-card {
      width: 420px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 1.25rem;
      color: #e6edf3;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .chaos-card h3 { margin: 0; font-size: 1.1rem; color: #58a6ff; }
    .chaos-card p { margin: 0; font-size: 0.8rem; color: #8b949e; }
    .chaos-group { display: flex; flex-direction: column; gap: 0.4rem; }
    .chaos-group .group-label { margin: 0; font-size: 0.8rem; font-weight: 600; }
    .btn-row { display: flex; gap: 0.5rem; }
    .btn-row button {
      flex: 1;
      padding: 0.4rem;
      background: #21262d;
      border: 1px solid #30363d;
      color: #8b949e;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-row button.active { background: #1f6feb; color: white; border-color: #388bfd; }
    .drill-list { display: flex; flex-direction: column; gap: 0.4rem; }
    .drill-list button {
      padding: 0.45rem;
      text-align: left;
      background: #21262d;
      border: 1px solid #30363d;
      color: #f85149;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .drill-list .btn-restore { background: #0e2e1e; border-color: #238636; color: #3fb950; font-weight: 700; }
    .btn-close {
      background: #30363d;
      border: none;
      color: white;
      padding: 0.5rem;
      border-radius: 4px;
      cursor: pointer;
    }
  `]
})
export class HeaderComponent {
  auth = inject(AuthService);
  stream = inject(MetricsStreamService);
  rulesEngine = inject(RulesEngineService);

  showChaosModal = signal(false);

  toggleChaosMenu(): void {
    this.showChaosModal.update(v => !v);
  }

  closeChaosMenuOnBackdrop(event: Event): void {
    if (event.target === event.currentTarget) this.toggleChaosMenu();
  }

  // Exact statuses matching requirement E1:
  getStatusText(): string {
    const status = this.stream.connectionStatus();
    const transport = this.stream.activeTransport();

    if (this.stream.isStale()) {
      return `Stale: last event ${this.stream.secondsSinceLastEvent()} s ago`;
    }
    if (status === 'Offline') return 'Disconnected';
    if (status === 'Reconnecting') return 'Reconnecting';
    if (status === 'Live') return `Live ${transport}`;
    return 'Stale';
  }

  getPillClass(): string {
    if (this.stream.isStale()) return 'pill-stale';
    const status = this.stream.connectionStatus();
    if (status === 'Offline') return 'pill-offline';
    if (status === 'Reconnecting') return 'pill-reconnecting';
    return 'pill-live';
  }
}
