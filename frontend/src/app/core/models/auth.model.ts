// Two allowed user roles (from the project brief)
export type UserRole = 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  role: UserRole;
}
