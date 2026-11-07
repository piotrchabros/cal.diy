import { createPaymentCallbackHandler } from "@calcom/app-store/stripepayment/api/paymentCallback";
import { assignPremiumUsername } from "@server/lib/stripepayment/assignPremiumUsername";

// app-store cannot import the organizations service, so the premium username is assigned through addMember
// here; this static route shadows the integrations [...args] catch-all, like webhook.ts next to it
export default createPaymentCallbackHandler(assignPremiumUsername);
