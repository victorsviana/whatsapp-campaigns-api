import type { Campaign } from '../../database/schema';
import { AppError } from '../../shared/errors/app-error';
import type { CampaignsRepository } from './campaigns.repository';
import type { CreateCampaignInput } from './campaigns.schemas';
import { type ContactInput, normalizePhone, type RejectedContact, validateContacts } from './contact-validator';
import { extractVariables } from './template';

export type CampaignsService = ReturnType<typeof createCampaignsService>;

export type AddContactsResult = {
  accepted: number;
  rejected: RejectedContact[];
};

function candidatePhones(contacts: ContactInput[]): string[] {
  const phones = new Set<string>();
  for (const contact of contacts) {
    const result = normalizePhone(contact.phone);
    if (result.ok) {
      phones.add(result.phone);
    }
  }
  return [...phones];
}

export function createCampaignsService(repository: CampaignsRepository) {
  return {
    createCampaign(input: CreateCampaignInput): Promise<Campaign> {
      return repository.create({
        name: input.name,
        template: input.template,
        variables: extractVariables(input.template),
      });
    },

    addContacts(campaignId: string, contacts: ContactInput[]): Promise<AddContactsResult> {
      return repository.transaction(async (tx) => {
        const campaign = await tx.findByIdForUpdate(campaignId);
        if (!campaign) {
          throw new AppError(404, 'campaign_not_found', 'Campaign not found');
        }
        if (campaign.status !== 'draft') {
          throw new AppError(409, 'campaign_not_draft', 'Contacts can only be added to draft campaigns');
        }

        const existingPhones = await tx.findExistingPhones(campaignId, candidatePhones(contacts));
        const { accepted, rejected } = validateContacts(contacts, campaign.variables, existingPhones);

        await tx.insertContacts(campaignId, accepted);
        await tx.incrementRejectedContacts(campaignId, rejected.length);

        return { accepted: accepted.length, rejected };
      });
    },
  };
}
