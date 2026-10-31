import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { roleGuard } from './core/guards/role.guard';
import { unsavedChangesGuard } from './core/guards/unsaved-changes.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'services'
  },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.component').then(m => m.LoginComponent)
  },
  {
    path: 'services',
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/fleet-table/fleet-table.component').then(m => m.FleetTableComponent)
      },
      {
        path: ':id',
        // Lazy loaded so charts are NOT in the initial bundle (Brief Performance Target)
        loadComponent: () =>
          import('./features/service-detail/service-detail.component').then(m => m.ServiceDetailComponent)
      }
    ]
  },
  {
    path: 'rules',
    canActivate: [authGuard, roleGuard], // Enforces operator role (Brief A6)
    children: [
      {
        path: '',
        // Lazy loaded (Brief Performance Target: rules not in initial bundle)
        loadComponent: () =>
          import('./features/rules/rules-list.component').then(m => m.RulesListComponent)
      },
      {
        path: 'new',
        canDeactivate: [unsavedChangesGuard], // Brief D5
        loadComponent: () =>
          import('./features/rules/rule-form.component').then(m => m.RuleFormComponent)
      },
      {
        path: 'edit/:id',
        canDeactivate: [unsavedChangesGuard], // Brief D5
        loadComponent: () =>
          import('./features/rules/rule-form.component').then(m => m.RuleFormComponent)
      }
    ]
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/settings/settings.component').then(m => m.SettingsComponent)
  },
  {
    path: '**',
    redirectTo: 'services'
  }
];
