import { sendNotificationSlot } from './_shared/notifications.mjs';

export default async () => {
  await sendNotificationSlot(1);
};

export const config = { schedule: '30 3 * * *' };
