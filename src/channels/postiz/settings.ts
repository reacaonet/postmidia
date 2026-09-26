import type { Network } from '../../domain/networks';
import type { ValidationIssue } from '../adapter';
import type { PublishSpec } from '../adapter';

export interface SettingsBuild {
  settings: Record<string, unknown> | null;
  issues: ValidationIssue[];
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const normalizeTags = (value: unknown): { value: string; label: string }[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return { value: item, label: item };
      }
      if (item && typeof item === 'object') {
        const entry = item as { value?: unknown; label?: unknown };
        const tag = asString(entry.value);
        if (tag) {
          return { value: tag, label: asString(entry.label) ?? tag };
        }
      }
      return null;
    })
    .filter((item): item is { value: string; label: string } => item !== null);
};

const withoutReserved = (settings: Record<string, unknown>): Record<string, unknown> => {
  const { __type: _omitted, ...rest } = settings;
  return rest;
};

const buildInstagram = (spec: PublishSpec): SettingsBuild => {
  const extra = withoutReserved(spec.settings);
  const postType = spec.contentType === 'story' ? 'story' : 'post';
  return {
    settings: { __type: 'instagram', post_type: postType, ...extra },
    issues: [],
  };
};

const buildFacebook = (spec: PublishSpec): SettingsBuild => {
  const extra = withoutReserved(spec.settings);
  const url = asString(extra.url);
  const issues: ValidationIssue[] = [];

  if (url !== null && !/^https?:\/\//i.test(url)) {
    issues.push({ field: 'text', code: 'invalid_url', message: 'Facebook url deve ser http(s)' });
  }

  return {
    settings: { __type: 'facebook', ...(url ? { url } : {}), ...extra },
    issues,
  };
};

const buildLinkedin = (spec: PublishSpec): SettingsBuild => {
  const extra = withoutReserved(spec.settings);
  const type = asString(extra.__typeOverride) ?? 'linkedin';
  const issues: ValidationIssue[] = [];

  if (type !== 'linkedin' && type !== 'linkedin-page') {
    issues.push({
      field: 'account',
      code: 'invalid_linkedin_type',
      message: `LinkedIn aceita "linkedin" ou "linkedin-page", recebido ${type}`,
    });
  }

  return {
    settings: { __type: type, ...extra, __typeOverride: undefined },
    issues,
  };
};

const buildX = (spec: PublishSpec): SettingsBuild => {
  const extra = withoutReserved(spec.settings);
  const whoCanReply = asString(extra.who_can_reply_post) ?? 'everyone';
  const issues: ValidationIssue[] = [];

  if (!['everyone', 'following', 'mentioned'].includes(whoCanReply)) {
    issues.push({
      field: 'text',
      code: 'invalid_who_can_reply_post',
      message: `who_can_reply_post invalido: ${whoCanReply}`,
    });
  }

  return {
    settings: { __type: 'x', who_can_reply_post: whoCanReply, ...extra },
    issues,
  };
};

const buildYoutube = (spec: PublishSpec): SettingsBuild => {
  const extra = withoutReserved(spec.settings);
  const title = asString(extra.title);
  const visibility = asString(extra.type) ?? 'public';
  const madeForKids = asString(extra.selfDeclaredMadeForKids) ?? 'no';
  const issues: ValidationIssue[] = [];

  if (!title) {
    issues.push({
      field: 'text',
      code: 'youtube_title_required',
      message: 'YouTube exige settings.title',
    });
  } else if (title.length < 2 || title.length > 100) {
    issues.push({
      field: 'text',
      code: 'youtube_title_invalid',
      message: `YouTube title deve ter 2-100 caracteres, recebido ${title.length}`,
    });
  }

  if (!['public', 'unlisted', 'private'].includes(visibility)) {
    issues.push({
      field: 'account',
      code: 'youtube_type_invalid',
      message: `YouTube type invalido: ${visibility}`,
    });
  }

  if (!['yes', 'no'].includes(madeForKids)) {
    issues.push({
      field: 'account',
      code: 'youtube_kids_invalid',
      message: `selfDeclaredMadeForKids deve ser "yes" ou "no", recebido ${madeForKids}`,
    });
  }

  return {
    settings: {
      __type: 'youtube',
      ...(title ? { title } : {}),
      type: visibility,
      selfDeclaredMadeForKids: madeForKids,
      tags: normalizeTags(extra.tags),
      ...extra,
    },
    issues,
  };
};

const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
];

const buildTiktok = (spec: PublishSpec): SettingsBuild => {
  const extra = withoutReserved(spec.settings);
  const title = asString(extra.title) ?? '';
  const privacyLevel = asString(extra.privacy_level) ?? 'PUBLIC_TO_EVERYONE';
  const postingMethod = asString(extra.content_posting_method) ?? 'DIRECT_POST';
  const autoAddMusic = asString(extra.autoAddMusic) ?? 'no';
  const issues: ValidationIssue[] = [];

  if (title.length > 90) {
    issues.push({
      field: 'text',
      code: 'tiktok_title_too_long',
      message: `TikTok title excede 90 caracteres (${title.length})`,
    });
  }

  if (!TIKTOK_PRIVACY_LEVELS.includes(privacyLevel)) {
    issues.push({
      field: 'account',
      code: 'tiktok_privacy_invalid',
      message: `privacy_level invalido: ${privacyLevel}`,
    });
  }

  if (postingMethod !== 'DIRECT_POST' && postingMethod !== 'UPLOAD') {
    issues.push({
      field: 'account',
      code: 'tiktok_posting_method_invalid',
      message: `content_posting_method invalido: ${postingMethod}`,
    });
  }

  return {
    settings: {
      __type: 'tiktok',
      title,
      privacy_level: privacyLevel,
      duet: asBoolean(extra.duet, true),
      stitch: asBoolean(extra.stitch, true),
      comment: asBoolean(extra.comment, true),
      autoAddMusic,
      brand_content_toggle: asBoolean(extra.brand_content_toggle, false),
      brand_organic_toggle: asBoolean(extra.brand_organic_toggle, false),
      video_made_with_ai: asBoolean(extra.video_made_with_ai, false),
      content_posting_method: postingMethod,
      ...extra,
    },
    issues,
  };
};

const BUILDERS: Record<string, (spec: PublishSpec) => SettingsBuild> = {
  instagram: buildInstagram,
  facebook: buildFacebook,
  linkedin: buildLinkedin,
  x: buildX,
  youtube: buildYoutube,
  tiktok: buildTiktok,
};

export const buildPostizSettings = (network: Network, spec: PublishSpec): SettingsBuild => {
  const builder = BUILDERS[network];
  if (!builder) {
    return {
      settings: null,
      issues: [
        { field: 'account', code: 'unsupported_by_postiz', message: `Postiz nao tem builder para ${network}` },
      ],
    };
  }
  return builder(spec);
};

export const tikTokPostingMethod = (spec: PublishSpec): string =>
  (asString(spec.settings.content_posting_method) ?? 'DIRECT_POST');

export const collectedSettingsTags = (spec: PublishSpec): string[] => asStringArray(spec.settings.tags);
