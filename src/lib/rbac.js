'use strict';
// Single source of truth for roles & permissions.
const PERMISSIONS = {
  'articles.create': 'Create articles',
  'articles.edit_own': 'Edit own drafts',
  'articles.edit_any': 'Edit any article',
  'articles.submit': 'Submit articles for review',
  'articles.review': 'Review / approve / reject submissions',
  'articles.publish': 'Publish & unpublish articles',
  'articles.schedule': 'Schedule publication',
  'articles.feature': 'Choose featured / breaking articles',
  'articles.archive': 'Archive & restore articles',
  'articles.delete': 'Delete articles',
  'categories.manage': 'Manage categories',
  'tags.manage': 'Manage tags',
  'media.upload': 'Upload media',
  'media.manage': 'Manage / delete media',
  'comments.moderate': 'Moderate comments',
  'ads.manage': 'Manage advertisements',
  'ads.stats': 'View advertising statistics',
  'users.view': 'View users',
  'users.manage': 'Create / edit users and reset passwords',
  'roles.manage': 'Assign roles & permissions',
  'journalists.manage': 'Manage journalists',
  'settings.manage': 'Manage platform settings',
  'analytics.view': 'View analytics',
  'audit.view': 'View audit logs',
};
const ALL = Object.keys(PERMISSIONS);

const ROLES = {
  super_admin: { ar: 'مدير عام', fr: 'Super administrateur', perms: ALL },
  admin: {
    ar: 'مدير', fr: 'Administrateur',
    perms: ['articles.create', 'articles.edit_own', 'articles.edit_any', 'articles.submit', 'articles.review', 'articles.publish', 'articles.schedule',
      'articles.feature', 'articles.archive', 'articles.delete', 'categories.manage', 'tags.manage', 'media.upload', 'media.manage',
      'comments.moderate', 'journalists.manage', 'users.view', 'analytics.view'],
  },
  editor: {
    ar: 'محرر', fr: 'Rédacteur en chef',
    perms: ['articles.create', 'articles.edit_own', 'articles.edit_any', 'articles.submit', 'articles.review', 'articles.publish', 'articles.schedule',
      'articles.feature', 'articles.archive', 'tags.manage', 'media.upload'],
  },
  journalist: {
    ar: 'صحفي', fr: 'Journaliste',
    perms: ['articles.create', 'articles.edit_own', 'articles.submit', 'media.upload'],
  },
  ad_manager: {
    ar: 'مسؤول الإعلانات', fr: 'Responsable publicité',
    perms: ['ads.manage', 'ads.stats', 'media.upload'],
  },
};

module.exports = { PERMISSIONS, ROLES, ALL };
