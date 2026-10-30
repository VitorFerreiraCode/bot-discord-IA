export type DiscordAction =
  | {
      type: 'set_channel_visibility';
      channelId: string;
      targetType: 'member' | 'role';
      targetId: string;
      visible: boolean;
      reason: string;
    }
  | {
      type: 'create_category';
      name: string;
      reason: string;
    }
  | {
      type: 'create_text_channel';
      name: string;
      categoryId: string | null;
      privateToRequester: boolean;
      reason: string;
    };

export interface ProposedPlan {
  summary: string;
  actions: DiscordAction[];
}
