import type { Campaign } from '../../database/schema';
import type { CampaignsRepository } from './campaigns.repository';
import type { CreateCampaignInput } from './campaigns.schemas';
import { extractVariables } from './template';

export type CampaignsService = ReturnType<typeof createCampaignsService>;

export function createCampaignsService(repository: CampaignsRepository) {
  return {
    createCampaign(input: CreateCampaignInput): Promise<Campaign> {
      return repository.create({
        name: input.name,
        template: input.template,
        variables: extractVariables(input.template),
      });
    },
  };
}
