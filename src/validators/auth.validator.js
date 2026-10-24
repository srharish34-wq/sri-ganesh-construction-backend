import { z } from 'zod';
import { password } from './common.validator.js';

// identifier = email or phone number
export const loginSchema = z.object({
  body: z.object({
    identifier: z.string().trim().min(3, 'Enter your email or phone').max(150),
    password: z.string().min(1, 'Enter your password').max(200),
  }),
});

const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });

export const refreshSchema = z.object({ body: refreshBody });
export const logoutSchema = z.object({ body: refreshBody });

export const forgotPasswordSchema = z.object({
  body: z.object({ identifier: z.string().trim().min(3).max(150) }),
});

export const resetPasswordSchema = z.object({
  body: z
    .object({
      token: z.string().min(20).max(200),
      newPassword: password,
      confirmPassword: z.string(),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
      path: ['confirmPassword'],
      message: 'Passwords do not match',
    }),
});

export const changePasswordSchema = z.object({
  body: z
    .object({
      currentPassword: z.string().min(1, 'Enter your current password').max(200),
      newPassword: password,
      confirmPassword: z.string(),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
      path: ['confirmPassword'],
      message: 'Passwords do not match',
    })
    .refine((d) => d.newPassword !== d.currentPassword, {
      path: ['newPassword'],
      message: 'New password must be different from the current one',
    }),
});