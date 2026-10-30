export const SAFE_ROLE_PERMISSION_NAMES = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessages',
  'Connect',
  'Speak',
  'UseApplicationCommands',
  'AddReactions',
  'EmbedLinks',
  'AttachFiles',
] as const;

export type SafeRolePermission = typeof SAFE_ROLE_PERMISSION_NAMES[number];

export const CHANNEL_PERMISSION_NAMES = ['ViewChannel', 'ReadMessageHistory', 'Connect', 'Speak'] as const;
export type ChannelPermissionName = typeof CHANNEL_PERMISSION_NAMES[number];
export type ChannelPermissionChanges = Partial<Record<ChannelPermissionName, boolean>>;

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
      type: 'allow_read_history';
      channelId: string;
      targetType: 'member' | 'role';
      targetId: string;
      reason: string;
    }
  | {
      type: 'set_channel_permissions';
      channelId: string;
      targetType: 'member' | 'role';
      targetId: string;
      permissions: ChannelPermissionChanges;
      reason: string;
    }
  | {
      type: 'set_category_permissions';
      categoryId: string;
      targetType: 'member' | 'role';
      targetId: string;
      permissions: ChannelPermissionChanges;
      reason: string;
    }
  | {
      type: 'create_role';
      name: string;
      permissions: SafeRolePermission[];
      reason: string;
    }
  | {
      type: 'recreate_role_for_category';
      roleId: string;
      categoryId: string;
      reason: string;
    }
  | {
      type: 'delete_role';
      roleId: string;
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
