import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <div class="login-wrapper">
      <div class="login-card">
        <div class="brand">
          <span class="icon">⚡</span>
          <h1>Fleet Pulse</h1>
          <p>Real-Time Microservices Operations Console</p>
        </div>

        <!-- Server Error Banner (Requirement A1) -->
        <div *ngIf="auth.loginError()" class="alert-error">
          ⚠️ {{ auth.loginError() }}
        </div>

        <!-- Reactive Form (Requirement A1) -->
        <form [formGroup]="loginForm" (ngSubmit)="onSubmit()" class="login-form">
          <div class="form-group">
            <label for="email">Email</label>
            <input
              id="email"
              type="email"
              formControlName="email"
              
            />
            <span *ngIf="loginForm.get('email')?.invalid && loginForm.get('email')?.touched" class="err">
              Please enter a valid email.
            </span>
          </div>

          <div class="form-group">
            <label for="password">Password</label>
            <input
              id="password"
              type="password"
              formControlName="password"
              
            />
            <span *ngIf="loginForm.get('password')?.invalid && loginForm.get('password')?.touched" class="err">
              Password is required.
            </span>
          </div>

          <!-- Submit disabled while form is invalid -->
          <button type="submit" class="btn-signin" [disabled]="loginForm.invalid || auth.isLoading()">
            Sign In to Console
          </button>
        </form>

        <!-- Quick Pre-fill Buttons for Interview Reviewers -->
        <div class="quick-fill">
          <span>Quick Login Helpers (Click to pre-fill):</span>
          <button type="button" (click)="fill('operator@pulse.dev')">
            🧑‍💻 Operator (operator@pulse.dev)
          </button>
          <button type="button" (click)="fill('viewer@pulse.dev')">
            👁️ Viewer (viewer@pulse.dev)
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .login-wrapper {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #090d13;
      padding: 1rem;
    }
    .login-card {
      width: 100%;
      max-width: 400px;
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 10px;
      padding: 2rem;
      color: #e6edf3;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .brand { text-align: center; }
    .icon { font-size: 2rem; color: #58a6ff; }
    .brand h1 { margin: 0.35rem 0 0.15rem 0; font-size: 1.6rem; }
    .brand p { margin: 0; color: #8b949e; font-size: 0.8rem; }

    .alert-error {
      background: #3c1618;
      border: 1px solid #da3633;
      color: #ff7b72;
      padding: 0.6rem 0.8rem;
      border-radius: 6px;
      font-size: 0.8rem;
    }

    .login-form { display: flex; flex-direction: column; gap: 1rem; }
    .form-group { display: flex; flex-direction: column; gap: 0.35rem; }
    .form-group label { font-size: 0.8rem; font-weight: 600; color: #c9d1d9; }
    .form-group input {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 0.55rem 0.75rem;
      color: #e6edf3;
      font-size: 0.9rem;
      outline: none;
    }
    .form-group input:focus { border-color: #58a6ff; }
    .err { font-size: 0.75rem; color: #f85149; }

    .btn-signin {
      background: #238636;
      color: white;
      border: none;
      padding: 0.65rem;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
      margin-top: 0.5rem;
    }
    .btn-signin:hover:not(:disabled) { background: #2ea043; }
    .btn-signin:disabled { opacity: 0.5; cursor: not-allowed; }

    .quick-fill {
      border-top: 1px solid #21262d;
      padding-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .quick-fill span { font-size: 0.75rem; color: #8b949e; text-align: center; }
    .quick-fill button {
      background: #161b22;
      border: 1px solid #30363d;
      color: #c9d1d9;
      padding: 0.4rem;
      border-radius: 4px;
      font-size: 0.75rem;
      cursor: pointer;
      text-align: left;
    }
    .quick-fill button:hover { background: #21262d; border-color: #58a6ff; }
  `]
})
export class LoginComponent {
  auth = inject(AuthService);
  private fb = inject(FormBuilder);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  loginForm: FormGroup = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]]
  });

  fill(email: string): void {
    this.loginForm.patchValue({ email, password: 'pulse123' });
  }

  async onSubmit(): Promise<void> {
    if (this.loginForm.invalid) return;

    const { email, password } = this.loginForm.value;
    const ok = await this.auth.login(email, password);

    if (ok) {
      const returnUrl = this.route.snapshot.queryParams['returnUrl'] || '/services';
      this.router.navigateByUrl(returnUrl);
    }
  }
}
