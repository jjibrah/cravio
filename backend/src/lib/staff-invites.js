/* Sends queued staff invites with the service client. One failure never stops the others. */
import { invalidateUser } from './cache.js';

const PROFILE_ROLE = { manager: 'owner', waiter: 'waiter' };

export function welcomeUrl() {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/welcome`;
}

function reasonFor(error) {
  const code = error?.code || '';
  const message = String(error?.message || '');
  if (code === 'email_exists' || /already been registered|already exists/i.test(message)) return 'This email already has a Cravio account. Ask them to sign in, or use another email.';
  if (code === 'over_email_send_rate_limit' || error?.status === 429 || /rate limit/i.test(message)) return 'Too many emails were sent just now. Try again in a few minutes.';
  if (code === 'email_address_invalid' || /invalid/i.test(message) && /email/i.test(message)) return 'The email provider rejected this address. Check it for typos.';
  return (message || 'The invite could not be sent.').slice(0, 300);
}

/**
 * @param service service-role Supabase client
 * @param restaurantId restaurant the staff join
 * @param invites rows from staff_invites (status queued or failed)
 * @returns rows after sending, each with status 'sent' or 'failed' and an error reason
 */
export async function sendStaffInvites(service, restaurantId, invites) {
  const results = [];
  for (const invite of invites) {
    let userId = invite.user_id || null;
    let update;
    try {
      if (!userId) {
        const { data, error } = await service.auth.admin.inviteUserByEmail(invite.email, {
          data: { name: invite.name, restaurant_id: restaurantId },
          redirectTo: welcomeUrl(),
        });
        if (error) throw error;
        userId = data.user.id;
        // Remember the account straight away so a retry finishes the setup instead of re-inviting.
        await service.from('staff_invites').update({ user_id: userId }).eq('id', invite.id);
      }
      // inviteUserByEmail writes user_metadata; the profile trigger reads app_metadata.role.
      const { error: roleError } = await service.auth.admin.updateUserById(userId, { app_metadata: { role: PROFILE_ROLE[invite.role] } });
      if (roleError) throw roleError;
      const { error: memberError } = await service.from('restaurant_members')
        .upsert({ restaurant_id: restaurantId, user_id: userId, role: invite.role }, { onConflict: 'restaurant_id,user_id' });
      if (memberError) throw memberError;
      invalidateUser(userId);
      update = { status: 'sent', error: null, sent_at: new Date().toISOString(), user_id: userId };
    } catch (error) {
      console.error(`Staff invite ${invite.id} failed:`, error?.code || error?.message);
      update = { status: 'failed', error: reasonFor(error), user_id: userId };
    }
    const { data: saved, error: saveError } = await service.from('staff_invites')
      .update(update).eq('id', invite.id).select('id, name, email, phone, role, status, error, sent_at').single();
    results.push(saveError ? { ...invite, ...update } : saved);
  }
  return results;
}
