import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

// Requirement A6: Viewers cannot reach /rules; only operators can
export const roleGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isOperator()) {
    return true; // Allow operators
  }

  // Block viewers and send them to the fleet page
  return router.createUrlTree(['/services']);
};
