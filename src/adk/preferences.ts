import { z } from 'zod';

export const preferencesSchema = z.object({
  language:z.enum(['English','Bengali','Hindi','Spanish']).optional(),
  verbosity:z.enum(['concise','balanced','detailed']).optional(),
  expertise:z.enum(['beginner','intermediate','advanced']).optional(),
  working_style:z.enum(['direct','collaborative','socratic']).optional(),
  preferred_role:z.enum(['engineering_partner','analyst','tutor']).optional(),
}).strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const preferenceSettingSchema = z.discriminatedUnion('key',[
  z.object({key:z.literal('language'),value:z.enum(['English','Bengali','Hindi','Spanish'])}).strict(),
  z.object({key:z.literal('verbosity'),value:z.enum(['concise','balanced','detailed'])}).strict(),
  z.object({key:z.literal('expertise'),value:z.enum(['beginner','intermediate','advanced'])}).strict(),
  z.object({key:z.literal('working_style'),value:z.enum(['direct','collaborative','socratic'])}).strict(),
  z.object({key:z.literal('preferred_role'),value:z.enum(['engineering_partner','analyst','tutor'])}).strict(),
]);
