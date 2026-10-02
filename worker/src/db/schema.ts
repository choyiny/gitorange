import * as authSchema from './auth.schema';
import * as appSchema from './app.schema';

export const schema = { ...authSchema, ...appSchema } as const;
