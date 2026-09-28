import { sendNotificationSlot } from './_shared/notifications.mjs';

export default async () => {
  await sendNotificationSlot(3);
};

export const config = { schedule: '30 9 * * *' };
