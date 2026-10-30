export const SAFE_ROLE_PERMISSION_NAMES = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessages',
  'Connect',
  'Speak',
  'ManageMessages',
  'ManageThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'SendMessagesInThreads',
  'ManageEvents',
  'ModerateMembers',
  'MoveMembers',
  'MuteMembers',
  'DeafenMembers',
  'UseVAD',
  'UseExternalEmojis',
  'UseExternalStickers',
  'UseSoundboard',
  'UseExternalSounds',
  'SendPolls',
  'SendVoiceMessages',
  'CreateEvents',
  'ChangeNickname',
  'ManageNicknames',
  'AttachFiles',
  'UseApplicationCommands',
  'AddReactions',
  'EmbedLinks',
] as const;

export type SafeRolePermission = typeof SAFE_ROLE_PERMISSION_NAMES[number];

export const CHANNEL_PERMISSION_NAMES = [
  'ViewChannel', 'ReadMessageHistory', 'SendMessages', 'SendMessagesInThreads',
  'CreatePublicThreads', 'CreatePrivateThreads', 'ManageThreads', 'ManageMessages',
  'AddReactions', 'EmbedLinks', 'AttachFiles', 'UseExternalEmojis', 'UseExternalStickers',
  'MentionEveryone', 'UseApplicationCommands', 'Connect', 'Speak', 'Stream', 'UseVAD',
  'PrioritySpeaker', 'MuteMembers', 'DeafenMembers', 'MoveMembers', 'ManageChannels',
  'ManageWebhooks', 'CreateInstantInvite', 'UseSoundboard', 'UseExternalSounds',
  'SendVoiceMessages', 'SendPolls', 'ManageEvents', 'CreateEvents', 'UseExternalApps',
] as const;
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
      type: 'set_voice_mute';
      memberId: string;
      muted: boolean;
      reason: string;
    }
  | {
      type: 'create_role';
      name: string;
      permissions: SafeRolePermission[];
      reason: string;
    }
  | { type: 'edit_channel'; channelId: string; changes: { name?: string; topic?: string | null; nsfw?: boolean; rateLimitPerUser?: number; userLimit?: number; bitrate?: number; parentId?: string | null }; reason: string }
  | { type: 'edit_role'; roleId: string; changes: { name?: string; permissions?: SafeRolePermission[]; color?: number; hoist?: boolean; mentionable?: boolean }; reason: string }
  | { type: 'set_member_role'; memberId: string; roleId: string; assigned: boolean; reason: string }
  | { type: 'delete_channel'; channelId: string; reason: string }
  | { type: 'edit_welcome_screen'; enabled?: boolean; description?: string; welcomeChannels?: Array<{ channelId: string; description: string; emoji?: string }>; reason: string }
  | { type: 'configure_onboarding_question'; title: string; options: Array<{ title: string; description?: string; roleNames: string[]; channelNames: string[] }>; required: boolean; singleSelect: boolean; enabled: boolean; reason: string }
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
