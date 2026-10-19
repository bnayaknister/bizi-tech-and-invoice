export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          accountant_email: string | null
          calendar_sync_enabled: boolean
          documents_last_full_scan_at: string | null
          documents_pulled_at: string | null
          id: boolean
          updated_at: string
        }
        Insert: {
          accountant_email?: string | null
          calendar_sync_enabled?: boolean
          documents_last_full_scan_at?: string | null
          documents_pulled_at?: string | null
          id?: boolean
          updated_at?: string
        }
        Update: {
          accountant_email?: string | null
          calendar_sync_enabled?: boolean
          documents_last_full_scan_at?: string | null
          documents_pulled_at?: string | null
          id?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      approval_requests: {
        Row: {
          action_type: string
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          payload: Json
          reason: string
          requested_by: string
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
        }
        Insert: {
          action_type: string
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          payload?: Json
          reason: string
          requested_by: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Update: {
          action_type?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          payload?: Json
          reason?: string
          requested_by?: string
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "approval_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      assistant_queries: {
        Row: {
          actor_id: string | null
          answer: string | null
          blocked: boolean
          created_at: string
          id: string
          question: string
          tools_used: Json
        }
        Insert: {
          actor_id?: string | null
          answer?: string | null
          blocked?: boolean
          created_at?: string
          id?: string
          question: string
          tools_used?: Json
        }
        Update: {
          actor_id?: string | null
          answer?: string | null
          blocked?: boolean
          created_at?: string
          id?: string
          question?: string
          tools_used?: Json
        }
        Relationships: [
          {
            foreignKeyName: "assistant_queries_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_contacts: {
        Row: {
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          name: string
          registration_id: string | null
          show_id: string
          wa_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          name: string
          registration_id?: string | null
          show_id: string
          wa_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          name?: string
          registration_id?: string | null
          show_id?: string
          wa_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_contacts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_contacts_registration_id_fkey"
            columns: ["registration_id"]
            isOneToOne: false
            referencedRelation: "client_registrations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_contacts_show_id_fkey"
            columns: ["show_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_links: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          revoked_at: string | null
          revoked_by: string | null
          show_id: string
          token: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          show_id: string
          token: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          show_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_links_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_links_show_id_fkey"
            columns: ["show_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id"]
          },
        ]
      }
      booking_requests: {
        Row: {
          calendar_delete_error: string | null
          calendar_delete_status: string | null
          calendar_event_id: string | null
          calendar_event_uid: string | null
          calendar_write_error: string | null
          calendar_write_status: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          end_at: string
          guest: string | null
          id: string
          link_id: string
          note: string | null
          production_id: string | null
          replaces_request_id: string | null
          show_id: string
          start_at: string
          status: string
          studio: string
        }
        Insert: {
          calendar_delete_error?: string | null
          calendar_delete_status?: string | null
          calendar_event_id?: string | null
          calendar_event_uid?: string | null
          calendar_write_error?: string | null
          calendar_write_status?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          end_at: string
          guest?: string | null
          id?: string
          link_id: string
          note?: string | null
          production_id?: string | null
          replaces_request_id?: string | null
          show_id: string
          start_at: string
          status?: string
          studio: string
        }
        Update: {
          calendar_delete_error?: string | null
          calendar_delete_status?: string | null
          calendar_event_id?: string | null
          calendar_event_uid?: string | null
          calendar_write_error?: string | null
          calendar_write_status?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          end_at?: string
          guest?: string | null
          id?: string
          link_id?: string
          note?: string | null
          production_id?: string | null
          replaces_request_id?: string | null
          show_id?: string
          start_at?: string
          status?: string
          studio?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_requests_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "booking_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_requests_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_requests_replaces_request_id_fkey"
            columns: ["replaces_request_id"]
            isOneToOne: false
            referencedRelation: "booking_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_requests_show_id_fkey"
            columns: ["show_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id"]
          },
        ]
      }
      client_morning_ids: {
        Row: {
          client_id: string
          created_at: string
          created_by: string | null
          is_primary: boolean
          morning_client_id: string
          morning_name: string | null
          note: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string | null
          is_primary?: boolean
          morning_client_id: string
          morning_name?: string | null
          note?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string | null
          is_primary?: boolean
          morning_client_id?: string
          morning_name?: string | null
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_morning_ids_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_morning_ids_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_registrations: {
        Row: {
          address: string | null
          booking_name_1: string
          booking_name_2: string | null
          booking_wa_id_1: string
          booking_wa_id_1_verified: boolean
          booking_wa_id_2: string | null
          booking_wa_id_2_verified: boolean
          client_id: string | null
          contact_name: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          duplicate_of_client_id: string | null
          emails: string[]
          id: string
          legal_name: string
          link_id: string | null
          phone: string
          podcast_name: string
          privacy_accepted_at: string
          privacy_version: string
          reject_reason: string | null
          rejected_at: string | null
          source: string
          status: string
          tax_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          booking_name_1: string
          booking_name_2?: string | null
          booking_wa_id_1: string
          booking_wa_id_1_verified?: boolean
          booking_wa_id_2?: string | null
          booking_wa_id_2_verified?: boolean
          client_id?: string | null
          contact_name?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          duplicate_of_client_id?: string | null
          emails: string[]
          id?: string
          legal_name: string
          link_id?: string | null
          phone: string
          podcast_name: string
          privacy_accepted_at: string
          privacy_version: string
          reject_reason?: string | null
          rejected_at?: string | null
          source: string
          status?: string
          tax_id: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          booking_name_1?: string
          booking_name_2?: string | null
          booking_wa_id_1?: string
          booking_wa_id_1_verified?: boolean
          booking_wa_id_2?: string | null
          booking_wa_id_2_verified?: boolean
          client_id?: string | null
          contact_name?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          duplicate_of_client_id?: string | null
          emails?: string[]
          id?: string
          legal_name?: string
          link_id?: string | null
          phone?: string
          podcast_name?: string
          privacy_accepted_at?: string
          privacy_version?: string
          reject_reason?: string | null
          rejected_at?: string | null
          source?: string
          status?: string
          tax_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_registrations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_registrations_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_registrations_duplicate_of_client_id_fkey"
            columns: ["duplicate_of_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_registrations_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "registration_links"
            referencedColumns: ["id"]
          },
        ]
      }
      client_review_approvals: {
        Row: {
          backfill_source: string | null
          created_at: string
          decided_at: string
          decision: string
          id: string
          is_backfill: boolean
          item_id: string
          link_id: string | null
          note: string | null
          revoked_at: string | null
          revoked_reason: string | null
          version_id: string | null
        }
        Insert: {
          backfill_source?: string | null
          created_at?: string
          decided_at: string
          decision: string
          id?: string
          is_backfill?: boolean
          item_id: string
          link_id?: string | null
          note?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          version_id?: string | null
        }
        Update: {
          backfill_source?: string | null
          created_at?: string
          decided_at?: string
          decision?: string
          id?: string
          is_backfill?: boolean
          item_id?: string
          link_id?: string | null
          note?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_review_approvals_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "client_review_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_approvals_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "client_review_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cra_version_item_fk"
            columns: ["version_id", "item_id"]
            isOneToOne: false
            referencedRelation: "client_review_versions"
            referencedColumns: ["id", "item_id"]
          },
        ]
      }
      client_review_comments: {
        Row: {
          acked_at: string | null
          acked_by: string | null
          after_response: boolean
          author_id: string | null
          author_kind: string
          author_name: string | null
          backfill_source: string | null
          body: string
          created_at: string
          id: string
          is_backfill: boolean
          item_id: string
          kind: string
          link_id: string | null
          pin_number: number | null
          resolved_at: string | null
          resolved_by: string | null
          time_ms: number | null
          version_id: string | null
        }
        Insert: {
          acked_at?: string | null
          acked_by?: string | null
          after_response?: boolean
          author_id?: string | null
          author_kind: string
          author_name?: string | null
          backfill_source?: string | null
          body: string
          created_at?: string
          id?: string
          is_backfill?: boolean
          item_id: string
          kind: string
          link_id?: string | null
          pin_number?: number | null
          resolved_at?: string | null
          resolved_by?: string | null
          time_ms?: number | null
          version_id?: string | null
        }
        Update: {
          acked_at?: string | null
          acked_by?: string | null
          after_response?: boolean
          author_id?: string | null
          author_kind?: string
          author_name?: string | null
          backfill_source?: string | null
          body?: string
          created_at?: string
          id?: string
          is_backfill?: boolean
          item_id?: string
          kind?: string
          link_id?: string | null
          pin_number?: number | null
          resolved_at?: string | null
          resolved_by?: string | null
          time_ms?: number | null
          version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_review_comments_acked_by_fkey"
            columns: ["acked_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_comments_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "client_review_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_comments_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: false
            referencedRelation: "client_review_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_comments_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crc_version_item_fk"
            columns: ["version_id", "item_id"]
            isOneToOne: false
            referencedRelation: "client_review_versions"
            referencedColumns: ["id", "item_id"]
          },
        ]
      }
      client_review_items: {
        Row: {
          approved: boolean
          approved_at: string | null
          created_at: string
          id: string
          kind: string
          last_note: string | null
          media_link: string | null
          production_id: string
          reel_index: number | null
        }
        Insert: {
          approved?: boolean
          approved_at?: string | null
          created_at?: string
          id?: string
          kind: string
          last_note?: string | null
          media_link?: string | null
          production_id: string
          reel_index?: number | null
        }
        Update: {
          approved?: boolean
          approved_at?: string | null
          created_at?: string
          id?: string
          kind?: string
          last_note?: string | null
          media_link?: string | null
          production_id?: string
          reel_index?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_review_items_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      client_review_links: {
        Row: {
          audio_carried_from: string | null
          audio_link: string | null
          created_at: string
          created_by: string | null
          episode_link: string | null
          episode_note: string | null
          episode_response: string | null
          expires_at: string
          first_opened_at: string | null
          id: string
          last_opened_at: string | null
          open_count: number
          production_id: string
          reels_included: boolean
          reels_link: string | null
          reels_note: string | null
          reels_response: string | null
          responded_at: string | null
          scope: string
          superseded: boolean
          token: string
        }
        Insert: {
          audio_carried_from?: string | null
          audio_link?: string | null
          created_at?: string
          created_by?: string | null
          episode_link?: string | null
          episode_note?: string | null
          episode_response?: string | null
          expires_at: string
          first_opened_at?: string | null
          id?: string
          last_opened_at?: string | null
          open_count?: number
          production_id: string
          reels_included?: boolean
          reels_link?: string | null
          reels_note?: string | null
          reels_response?: string | null
          responded_at?: string | null
          scope?: string
          superseded?: boolean
          token: string
        }
        Update: {
          audio_carried_from?: string | null
          audio_link?: string | null
          created_at?: string
          created_by?: string | null
          episode_link?: string | null
          episode_note?: string | null
          episode_response?: string | null
          expires_at?: string
          first_opened_at?: string | null
          id?: string
          last_opened_at?: string | null
          open_count?: number
          production_id?: string
          reels_included?: boolean
          reels_link?: string | null
          reels_note?: string | null
          reels_response?: string | null
          responded_at?: string | null
          scope?: string
          superseded?: boolean
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_review_links_audio_carried_from_fkey"
            columns: ["audio_carried_from"]
            isOneToOne: false
            referencedRelation: "client_review_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_links_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      client_review_transcripts: {
        Row: {
          carried_from_link_id: string | null
          char_count: number | null
          content: string
          created_at: string
          created_by: string | null
          link_id: string
          source: string
        }
        Insert: {
          carried_from_link_id?: string | null
          char_count?: number | null
          content: string
          created_at?: string
          created_by?: string | null
          link_id: string
          source: string
        }
        Update: {
          carried_from_link_id?: string | null
          char_count?: number | null
          content?: string
          created_at?: string
          created_by?: string | null
          link_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_review_transcripts_carried_from_link_id_fkey"
            columns: ["carried_from_link_id"]
            isOneToOne: false
            referencedRelation: "client_review_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_transcripts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_transcripts_link_id_fkey"
            columns: ["link_id"]
            isOneToOne: true
            referencedRelation: "client_review_links"
            referencedColumns: ["id"]
          },
        ]
      }
      client_review_versions: {
        Row: {
          bunny_library_id: number | null
          bunny_status: string | null
          bunny_status_at: string | null
          bunny_status_raw: number | null
          bunny_video_id: string | null
          created_at: string
          created_by: string | null
          delete_attempts: number
          delete_last_attempt_at: string | null
          delete_last_error: string | null
          drive_file_id: string | null
          drive_mime_type: string | null
          drive_sha256: string | null
          drive_size_bytes: number | null
          duration_ms: number | null
          fetch_requested_at: string | null
          has_original: boolean | null
          id: string
          integrity: string | null
          integrity_at: string | null
          is_audio_only: boolean
          is_backfill: boolean
          item_id: string
          media_deleted_at: string | null
          media_link: string | null
          number: number | null
          original_filename: string | null
          original_sha256: string | null
          original_size_bytes: number | null
          ready_at: string | null
          source: string
          timeline_offset_ms: number | null
        }
        Insert: {
          bunny_library_id?: number | null
          bunny_status?: string | null
          bunny_status_at?: string | null
          bunny_status_raw?: number | null
          bunny_video_id?: string | null
          created_at?: string
          created_by?: string | null
          delete_attempts?: number
          delete_last_attempt_at?: string | null
          delete_last_error?: string | null
          drive_file_id?: string | null
          drive_mime_type?: string | null
          drive_sha256?: string | null
          drive_size_bytes?: number | null
          duration_ms?: number | null
          fetch_requested_at?: string | null
          has_original?: boolean | null
          id?: string
          integrity?: string | null
          integrity_at?: string | null
          is_audio_only?: boolean
          is_backfill?: boolean
          item_id: string
          media_deleted_at?: string | null
          media_link?: string | null
          number?: number | null
          original_filename?: string | null
          original_sha256?: string | null
          original_size_bytes?: number | null
          ready_at?: string | null
          source: string
          timeline_offset_ms?: number | null
        }
        Update: {
          bunny_library_id?: number | null
          bunny_status?: string | null
          bunny_status_at?: string | null
          bunny_status_raw?: number | null
          bunny_video_id?: string | null
          created_at?: string
          created_by?: string | null
          delete_attempts?: number
          delete_last_attempt_at?: string | null
          delete_last_error?: string | null
          drive_file_id?: string | null
          drive_mime_type?: string | null
          drive_sha256?: string | null
          drive_size_bytes?: number | null
          duration_ms?: number | null
          fetch_requested_at?: string | null
          has_original?: boolean | null
          id?: string
          integrity?: string | null
          integrity_at?: string | null
          is_audio_only?: boolean
          is_backfill?: boolean
          item_id?: string
          media_deleted_at?: string | null
          media_link?: string | null
          number?: number | null
          original_filename?: string | null
          original_sha256?: string | null
          original_size_bytes?: number | null
          ready_at?: string | null
          source?: string
          timeline_offset_ms?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_review_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_review_versions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "client_review_items"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          billing_cadence: Database["public"]["Enums"]["billing_cadence"]
          billing_every_n: number | null
          billing_mode: Database["public"]["Enums"]["billing_mode"]
          contact_name: string | null
          created_at: string
          default_rate: number | null
          id: string
          merged_into: string | null
          morning_client_id: string | null
          name: string
          normalized_name: string
          payment_terms: Database["public"]["Enums"]["payment_terms"]
          status: string
          tax_id: string | null
        }
        Insert: {
          billing_cadence?: Database["public"]["Enums"]["billing_cadence"]
          billing_every_n?: number | null
          billing_mode?: Database["public"]["Enums"]["billing_mode"]
          contact_name?: string | null
          created_at?: string
          default_rate?: number | null
          id?: string
          merged_into?: string | null
          morning_client_id?: string | null
          name: string
          normalized_name: string
          payment_terms?: Database["public"]["Enums"]["payment_terms"]
          status?: string
          tax_id?: string | null
        }
        Update: {
          billing_cadence?: Database["public"]["Enums"]["billing_cadence"]
          billing_every_n?: number | null
          billing_mode?: Database["public"]["Enums"]["billing_mode"]
          contact_name?: string | null
          created_at?: string
          default_rate?: number | null
          id?: string
          merged_into?: string | null
          morning_client_id?: string | null
          name?: string
          normalized_name?: string
          payment_terms?: Database["public"]["Enums"]["payment_terms"]
          status?: string
          tax_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_merged_into_fkey"
            columns: ["merged_into"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_milestones: {
        Row: {
          amount: number
          contract_id: string
          created_at: string
          expected_date: string | null
          id: string
          is_estimated: boolean
          job_id: string | null
          name: string
          status: string
        }
        Insert: {
          amount: number
          contract_id: string
          created_at?: string
          expected_date?: string | null
          id?: string
          is_estimated?: boolean
          job_id?: string | null
          name: string
          status?: string
        }
        Update: {
          amount?: number
          contract_id?: string
          created_at?: string
          expected_date?: string | null
          id?: string
          is_estimated?: boolean
          job_id?: string | null
          name?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_milestones_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_milestones_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      contracts: {
        Row: {
          client_id: string
          created_at: string
          end_date: string | null
          id: string
          included_episodes: number | null
          name: string
          show_id: string | null
          start_date: string | null
          status: string
          total_amount: number
        }
        Insert: {
          client_id: string
          created_at?: string
          end_date?: string | null
          id?: string
          included_episodes?: number | null
          name: string
          show_id?: string | null
          start_date?: string | null
          status?: string
          total_amount: number
        }
        Update: {
          client_id?: string
          created_at?: string
          end_date?: string | null
          id?: string
          included_episodes?: number | null
          name?: string
          show_id?: string | null
          start_date?: string | null
          status?: string
          total_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "contracts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contracts_show_id_fkey"
            columns: ["show_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          amount: number | null
          archive_reason: string | null
          archived_at: string | null
          archived_by: string | null
          bundle_job_ids: string[] | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          client_id: string | null
          created_at: string
          currency: string
          document_date: string | null
          id: string
          job_id: string | null
          morning_client_id: string | null
          morning_client_name: string | null
          morning_doc_id: string
          morning_doc_number: string | null
          parent_doc_numbers: string[] | null
          parent_relation: string | null
          pdf_url: string | null
          production_id: string | null
          raw: Json | null
          sent_to: string[] | null
          source: string
          status: number | null
          type: number
          updated_at: string
        }
        Insert: {
          amount?: number | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          bundle_job_ids?: string[] | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id?: string | null
          created_at?: string
          currency?: string
          document_date?: string | null
          id?: string
          job_id?: string | null
          morning_client_id?: string | null
          morning_client_name?: string | null
          morning_doc_id: string
          morning_doc_number?: string | null
          parent_doc_numbers?: string[] | null
          parent_relation?: string | null
          pdf_url?: string | null
          production_id?: string | null
          raw?: Json | null
          sent_to?: string[] | null
          source: string
          status?: number | null
          type: number
          updated_at?: string
        }
        Update: {
          amount?: number | null
          archive_reason?: string | null
          archived_at?: string | null
          archived_by?: string | null
          bundle_job_ids?: string[] | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id?: string | null
          created_at?: string
          currency?: string
          document_date?: string | null
          id?: string
          job_id?: string | null
          morning_client_id?: string | null
          morning_client_name?: string | null
          morning_doc_id?: string
          morning_doc_number?: string | null
          parent_doc_numbers?: string[] | null
          parent_relation?: string | null
          pdf_url?: string | null
          production_id?: string | null
          raw?: Json | null
          sent_to?: string[] | null
          source?: string
          status?: number | null
          type?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_archived_by_fkey"
            columns: ["archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          actor_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          event_type: string
          id: string
          payload: Json | null
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          event_type: string
          id?: string
          payload?: Json | null
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          event_type?: string
          id?: string
          payload?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount: number
          amount_is_estimated: boolean
          client_id: string
          created_at: string
          date_is_estimated: boolean
          doc_number: string | null
          id: string
          issued_at: string
          issued_by: string | null
          job_id: string | null
          morning_doc_id: string | null
          pdf_url: string | null
          source: Database["public"]["Enums"]["invoice_source"]
          status: string
          type: Database["public"]["Enums"]["invoice_type"]
        }
        Insert: {
          amount: number
          amount_is_estimated?: boolean
          client_id: string
          created_at?: string
          date_is_estimated?: boolean
          doc_number?: string | null
          id?: string
          issued_at?: string
          issued_by?: string | null
          job_id?: string | null
          morning_doc_id?: string | null
          pdf_url?: string | null
          source?: Database["public"]["Enums"]["invoice_source"]
          status?: string
          type: Database["public"]["Enums"]["invoice_type"]
        }
        Update: {
          amount?: number
          amount_is_estimated?: boolean
          client_id?: string
          created_at?: string
          date_is_estimated?: boolean
          doc_number?: string | null
          id?: string
          issued_at?: string
          issued_by?: string | null
          job_id?: string | null
          morning_doc_id?: string | null
          pdf_url?: string | null
          source?: Database["public"]["Enums"]["invoice_source"]
          status?: string
          type?: Database["public"]["Enums"]["invoice_type"]
        }
        Relationships: [
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_productions: {
        Row: {
          created_at: string
          job_id: string
          production_id: string
        }
        Insert: {
          created_at?: string
          job_id: string
          production_id: string
        }
        Update: {
          created_at?: string
          job_id?: string
          production_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_productions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_productions_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          amount: number | null
          campaign: string | null
          client_id: string | null
          contract_id: string | null
          created_at: string
          date: string | null
          dismiss_reason: string | null
          dismissed: boolean
          dismissed_at: string | null
          dismissed_by: string | null
          due_date: string | null
          external_id: string | null
          id: string
          invoice_biz: string | null
          invoice_tax: string | null
          legacy: boolean
          manual_only: boolean
          notes: string | null
          paid: Database["public"]["Enums"]["paid_status"]
        }
        Insert: {
          amount?: number | null
          campaign?: string | null
          client_id?: string | null
          contract_id?: string | null
          created_at?: string
          date?: string | null
          dismiss_reason?: string | null
          dismissed?: boolean
          dismissed_at?: string | null
          dismissed_by?: string | null
          due_date?: string | null
          external_id?: string | null
          id?: string
          invoice_biz?: string | null
          invoice_tax?: string | null
          legacy?: boolean
          manual_only?: boolean
          notes?: string | null
          paid?: Database["public"]["Enums"]["paid_status"]
        }
        Update: {
          amount?: number | null
          campaign?: string | null
          client_id?: string | null
          contract_id?: string | null
          created_at?: string
          date?: string | null
          dismiss_reason?: string | null
          dismissed?: boolean
          dismissed_at?: string | null
          dismissed_by?: string | null
          due_date?: string | null
          external_id?: string | null
          id?: string
          invoice_biz?: string | null
          invoice_tax?: string | null
          legacy?: boolean
          manual_only?: boolean
          notes?: string | null
          paid?: Database["public"]["Enums"]["paid_status"]
        }
        Relationships: [
          {
            foreignKeyName: "jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_dismissed_by_fkey"
            columns: ["dismissed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      misc_production_suppliers: {
        Row: {
          created_at: string
          created_by: string | null
          due_date: string | null
          id: string
          misc_production_id: string
          paid_at: string | null
          price: number | null
          service: string | null
          supplier_name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          misc_production_id: string
          paid_at?: string | null
          price?: number | null
          service?: string | null
          supplier_name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          id?: string
          misc_production_id?: string
          paid_at?: string | null
          price?: number | null
          service?: string | null
          supplier_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "misc_production_suppliers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "misc_production_suppliers_misc_production_id_fkey"
            columns: ["misc_production_id"]
            isOneToOne: false
            referencedRelation: "misc_productions"
            referencedColumns: ["id"]
          },
        ]
      }
      misc_productions: {
        Row: {
          amount: number
          cancel_reason: string | null
          client_id: string
          client_order_ref: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          job_id: string | null
          name: string
          status: Database["public"]["Enums"]["misc_production_status"]
          updated_at: string
          updated_by: string | null
          work_date: string
        }
        Insert: {
          amount: number
          cancel_reason?: string | null
          client_id: string
          client_order_ref?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          job_id?: string | null
          name: string
          status?: Database["public"]["Enums"]["misc_production_status"]
          updated_at?: string
          updated_by?: string | null
          work_date: string
        }
        Update: {
          amount?: number
          cancel_reason?: string | null
          client_id?: string
          client_order_ref?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          job_id?: string | null
          name?: string
          status?: Database["public"]["Enums"]["misc_production_status"]
          updated_at?: string
          updated_by?: string | null
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "misc_productions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "misc_productions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "misc_productions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "misc_productions_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_documents: {
        Row: {
          amount: number | null
          approved_at: string | null
          approved_by: string | null
          attempts: number
          bundle_job_ids: string[] | null
          client_id: string | null
          consolidated_into: string | null
          created_at: string
          doc_type: Database["public"]["Enums"]["pending_doc_type"]
          id: string
          issued_at: string | null
          job_id: string | null
          last_error: string | null
          morning_doc_id: string | null
          morning_doc_number: string | null
          payload: Json
          pdf_url: string | null
          production_id: string | null
          reject_reason: string | null
          sent_to: string[] | null
          status: Database["public"]["Enums"]["pending_doc_status"]
        }
        Insert: {
          amount?: number | null
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          bundle_job_ids?: string[] | null
          client_id?: string | null
          consolidated_into?: string | null
          created_at?: string
          doc_type: Database["public"]["Enums"]["pending_doc_type"]
          id?: string
          issued_at?: string | null
          job_id?: string | null
          last_error?: string | null
          morning_doc_id?: string | null
          morning_doc_number?: string | null
          payload?: Json
          pdf_url?: string | null
          production_id?: string | null
          reject_reason?: string | null
          sent_to?: string[] | null
          status?: Database["public"]["Enums"]["pending_doc_status"]
        }
        Update: {
          amount?: number | null
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          bundle_job_ids?: string[] | null
          client_id?: string | null
          consolidated_into?: string | null
          created_at?: string
          doc_type?: Database["public"]["Enums"]["pending_doc_type"]
          id?: string
          issued_at?: string | null
          job_id?: string | null
          last_error?: string | null
          morning_doc_id?: string | null
          morning_doc_number?: string | null
          payload?: Json
          pdf_url?: string | null
          production_id?: string | null
          reject_reason?: string | null
          sent_to?: string[] | null
          status?: Database["public"]["Enums"]["pending_doc_status"]
        }
        Relationships: [
          {
            foreignKeyName: "pending_documents_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_documents_consolidated_into_fkey"
            columns: ["consolidated_into"]
            isOneToOne: false
            referencedRelation: "pending_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_documents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_documents_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      production_addons: {
        Row: {
          approved_via: string | null
          created_at: string
          created_by: string | null
          id: string
          is_reels_addon: boolean
          production_id: string
          quantity: number
          status: string
          title: string
          total: number | null
          unit_price: number | null
        }
        Insert: {
          approved_via?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_reels_addon?: boolean
          production_id: string
          quantity?: number
          status?: string
          title: string
          total?: number | null
          unit_price?: number | null
        }
        Update: {
          approved_via?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_reels_addon?: boolean
          production_id?: string
          quantity?: number
          status?: string
          title?: string
          total?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "production_addons_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_addons_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      production_log: {
        Row: {
          author_id: string | null
          created_at: string
          edited_at: string | null
          id: string
          kind: string
          note: string | null
          production_id: string
          stage_id: string | null
          stage_status: Database["public"]["Enums"]["stage_status"] | null
          step: Database["public"]["Enums"]["stage_step"] | null
          track: Database["public"]["Enums"]["stage_track"] | null
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          edited_at?: string | null
          id?: string
          kind?: string
          note?: string | null
          production_id: string
          stage_id?: string | null
          stage_status?: Database["public"]["Enums"]["stage_status"] | null
          step?: Database["public"]["Enums"]["stage_step"] | null
          track?: Database["public"]["Enums"]["stage_track"] | null
        }
        Update: {
          author_id?: string | null
          created_at?: string
          edited_at?: string | null
          id?: string
          kind?: string
          note?: string | null
          production_id?: string
          stage_id?: string | null
          stage_status?: Database["public"]["Enums"]["stage_status"] | null
          step?: Database["public"]["Enums"]["stage_step"] | null
          track?: Database["public"]["Enums"]["stage_track"] | null
        }
        Relationships: [
          {
            foreignKeyName: "production_log_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_log_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "production_log_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "stages"
            referencedColumns: ["id"]
          },
        ]
      }
      productions: {
        Row: {
          billing_block_reason: string | null
          board_archived_at: string | null
          board_archived_by: string | null
          calendar_changed: boolean
          calendar_dup_ack: boolean
          calendar_removed: boolean
          calendar_synced_at: string | null
          calendar_uid: string | null
          camera_count: number | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          client_id: string | null
          contract_id: string | null
          created_at: string
          episode_no: number | null
          external_id: string | null
          guest: string | null
          has_episode: boolean
          id: string
          kind: Database["public"]["Enums"]["production_kind"]
          legacy: boolean
          merged_into: string | null
          needs_attention: boolean
          notes: string | null
          on_hold: boolean
          on_hold_by: string | null
          on_hold_reason: string | null
          on_hold_since: string | null
          podcast_name: string
          price_override: number | null
          record_date: string | null
          record_time: string | null
          reels_count: number
          review_ack_at: string | null
          review_ack_by: string | null
          review_ack_link_id: string | null
          review_episode_approved: boolean
          review_episode_note: string | null
          review_reels_approved: boolean
          review_reels_note: string | null
          review_reels_required: boolean
          show_id: string | null
          split_count: number | null
          split_index: number | null
          status: Database["public"]["Enums"]["production_status"]
          storage_disk: string | null
          studio: string | null
          studio_hours: number | null
        }
        Insert: {
          billing_block_reason?: string | null
          board_archived_at?: string | null
          board_archived_by?: string | null
          calendar_changed?: boolean
          calendar_dup_ack?: boolean
          calendar_removed?: boolean
          calendar_synced_at?: string | null
          calendar_uid?: string | null
          camera_count?: number | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id?: string | null
          contract_id?: string | null
          created_at?: string
          episode_no?: number | null
          external_id?: string | null
          guest?: string | null
          has_episode?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["production_kind"]
          legacy?: boolean
          merged_into?: string | null
          needs_attention?: boolean
          notes?: string | null
          on_hold?: boolean
          on_hold_by?: string | null
          on_hold_reason?: string | null
          on_hold_since?: string | null
          podcast_name: string
          price_override?: number | null
          record_date?: string | null
          record_time?: string | null
          reels_count?: number
          review_ack_at?: string | null
          review_ack_by?: string | null
          review_ack_link_id?: string | null
          review_episode_approved?: boolean
          review_episode_note?: string | null
          review_reels_approved?: boolean
          review_reels_note?: string | null
          review_reels_required?: boolean
          show_id?: string | null
          split_count?: number | null
          split_index?: number | null
          status?: Database["public"]["Enums"]["production_status"]
          storage_disk?: string | null
          studio?: string | null
          studio_hours?: number | null
        }
        Update: {
          billing_block_reason?: string | null
          board_archived_at?: string | null
          board_archived_by?: string | null
          calendar_changed?: boolean
          calendar_dup_ack?: boolean
          calendar_removed?: boolean
          calendar_synced_at?: string | null
          calendar_uid?: string | null
          camera_count?: number | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id?: string | null
          contract_id?: string | null
          created_at?: string
          episode_no?: number | null
          external_id?: string | null
          guest?: string | null
          has_episode?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["production_kind"]
          legacy?: boolean
          merged_into?: string | null
          needs_attention?: boolean
          notes?: string | null
          on_hold?: boolean
          on_hold_by?: string | null
          on_hold_reason?: string | null
          on_hold_since?: string | null
          podcast_name?: string
          price_override?: number | null
          record_date?: string | null
          record_time?: string | null
          reels_count?: number
          review_ack_at?: string | null
          review_ack_by?: string | null
          review_ack_link_id?: string | null
          review_episode_approved?: boolean
          review_episode_note?: string | null
          review_reels_approved?: boolean
          review_reels_note?: string | null
          review_reels_required?: boolean
          show_id?: string | null
          split_count?: number | null
          split_index?: number | null
          status?: Database["public"]["Enums"]["production_status"]
          storage_disk?: string | null
          studio?: string | null
          studio_hours?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "productions_board_archived_by_fkey"
            columns: ["board_archived_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_merged_into_fkey"
            columns: ["merged_into"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_on_hold_by_fkey"
            columns: ["on_hold_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_review_ack_by_fkey"
            columns: ["review_ack_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_review_ack_link_id_fkey"
            columns: ["review_ack_link_id"]
            isOneToOne: false
            referencedRelation: "client_review_links"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_show_id_fkey"
            columns: ["show_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          approved: boolean
          can_edit_money: boolean
          can_edit_stages: boolean
          can_import: boolean
          can_manage_users: boolean
          can_view_money: boolean
          can_view_stages: boolean
          created_at: string
          email: string | null
          id: string
          name: string
          role: string | null
          studio_admin: boolean
        }
        Insert: {
          approved?: boolean
          can_edit_money?: boolean
          can_edit_stages?: boolean
          can_import?: boolean
          can_manage_users?: boolean
          can_view_money?: boolean
          can_view_stages?: boolean
          created_at?: string
          email?: string | null
          id: string
          name: string
          role?: string | null
          studio_admin?: boolean
        }
        Update: {
          approved?: boolean
          can_edit_money?: boolean
          can_edit_stages?: boolean
          can_import?: boolean
          can_manage_users?: boolean
          can_view_money?: boolean
          can_view_stages?: boolean
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          role?: string | null
          studio_admin?: boolean
        }
        Relationships: []
      }
      registration_links: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          revoked_at: string | null
          token: string
          used_at: string | null
          wa_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          revoked_at?: string | null
          token: string
          used_at?: string | null
          wa_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          revoked_at?: string | null
          token?: string
          used_at?: string | null
          wa_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "registration_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      schema_ledger: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          note: string | null
          version: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          note?: string | null
          version: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          note?: string | null
          version?: string
        }
        Relationships: []
      }
      shows: {
        Row: {
          active: boolean
          aliases: string[]
          billing_mode: Database["public"]["Enums"]["show_billing_mode"]
          camera_count: number | null
          client_id: string | null
          color: string | null
          created_at: string
          default_editor_id: string | null
          default_rate: number | null
          default_studio: string | null
          first_booking_needs_approval: boolean
          has_episode: boolean
          hourly_rate: number | null
          id: string
          internal_confirmed_at: string | null
          internal_confirmed_by: string | null
          is_oneoff: boolean
          name: string
          notes: string | null
          pricing_model: Database["public"]["Enums"]["show_pricing_model"]
          reels_count: number
          settings: Json
        }
        Insert: {
          active?: boolean
          aliases?: string[]
          billing_mode?: Database["public"]["Enums"]["show_billing_mode"]
          camera_count?: number | null
          client_id?: string | null
          color?: string | null
          created_at?: string
          default_editor_id?: string | null
          default_rate?: number | null
          default_studio?: string | null
          first_booking_needs_approval?: boolean
          has_episode?: boolean
          hourly_rate?: number | null
          id?: string
          internal_confirmed_at?: string | null
          internal_confirmed_by?: string | null
          is_oneoff?: boolean
          name: string
          notes?: string | null
          pricing_model?: Database["public"]["Enums"]["show_pricing_model"]
          reels_count?: number
          settings?: Json
        }
        Update: {
          active?: boolean
          aliases?: string[]
          billing_mode?: Database["public"]["Enums"]["show_billing_mode"]
          camera_count?: number | null
          client_id?: string | null
          color?: string | null
          created_at?: string
          default_editor_id?: string | null
          default_rate?: number | null
          default_studio?: string | null
          first_booking_needs_approval?: boolean
          has_episode?: boolean
          hourly_rate?: number | null
          id?: string
          internal_confirmed_at?: string | null
          internal_confirmed_by?: string | null
          is_oneoff?: boolean
          name?: string
          notes?: string | null
          pricing_model?: Database["public"]["Enums"]["show_pricing_model"]
          reels_count?: number
          settings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "shows_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shows_default_editor_id_fkey"
            columns: ["default_editor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shows_internal_confirmed_by_fkey"
            columns: ["internal_confirmed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      stages: {
        Row: {
          assignee_id: string | null
          created_at: string
          done_at: string | null
          guest: string | null
          id: string
          podcast_name: string
          production_id: string
          record_date: string | null
          status: Database["public"]["Enums"]["stage_status"]
          step: Database["public"]["Enums"]["stage_step"]
          track: Database["public"]["Enums"]["stage_track"]
        }
        Insert: {
          assignee_id?: string | null
          created_at?: string
          done_at?: string | null
          guest?: string | null
          id?: string
          podcast_name: string
          production_id: string
          record_date?: string | null
          status?: Database["public"]["Enums"]["stage_status"]
          step: Database["public"]["Enums"]["stage_step"]
          track: Database["public"]["Enums"]["stage_track"]
        }
        Update: {
          assignee_id?: string | null
          created_at?: string
          done_at?: string | null
          guest?: string | null
          id?: string
          podcast_name?: string
          production_id?: string
          record_date?: string | null
          status?: Database["public"]["Enums"]["stage_status"]
          step?: Database["public"]["Enums"]["stage_step"]
          track?: Database["public"]["Enums"]["stage_track"]
        }
        Relationships: [
          {
            foreignKeyName: "stages_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stages_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      stages_removed_snapshot: {
        Row: {
          assignee_id: string | null
          done_at: string | null
          id: string | null
          production_id: string | null
          reason: string | null
          snapshotted_at: string
          status: Database["public"]["Enums"]["stage_status"] | null
          step: Database["public"]["Enums"]["stage_step"] | null
          track: Database["public"]["Enums"]["stage_track"] | null
        }
        Insert: {
          assignee_id?: string | null
          done_at?: string | null
          id?: string | null
          production_id?: string | null
          reason?: string | null
          snapshotted_at?: string
          status?: Database["public"]["Enums"]["stage_status"] | null
          step?: Database["public"]["Enums"]["stage_step"] | null
          track?: Database["public"]["Enums"]["stage_track"] | null
        }
        Update: {
          assignee_id?: string | null
          done_at?: string | null
          id?: string | null
          production_id?: string | null
          reason?: string | null
          snapshotted_at?: string
          status?: Database["public"]["Enums"]["stage_status"] | null
          step?: Database["public"]["Enums"]["stage_step"] | null
          track?: Database["public"]["Enums"]["stage_track"] | null
        }
        Relationships: []
      }
      v_doc_count: {
        Row: {
          count: number | null
        }
        Insert: {
          count?: number | null
        }
        Update: {
          count?: number | null
        }
        Relationships: []
      }
      v_prev_job: {
        Row: {
          job_id: string | null
        }
        Insert: {
          job_id?: string | null
        }
        Update: {
          job_id?: string | null
        }
        Relationships: []
      }
      wa_contact_prefs: {
        Row: {
          created_at: string
          lang: string | null
          lang_set_at: string | null
          updated_at: string
          wa_id: string
        }
        Insert: {
          created_at?: string
          lang?: string | null
          lang_set_at?: string | null
          updated_at?: string
          wa_id: string
        }
        Update: {
          created_at?: string
          lang?: string | null
          lang_set_at?: string | null
          updated_at?: string
          wa_id?: string
        }
        Relationships: []
      }
      wa_conversations: {
        Row: {
          created_at: string
          expires_at: string
          show_id: string
          state: Json
          step: string
          updated_at: string
          version: number
          wa_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          show_id: string
          state: Json
          step: string
          updated_at?: string
          version?: number
          wa_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          show_id?: string
          state?: Json
          step?: string
          updated_at?: string
          version?: number
          wa_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wa_conversations_show_id_fkey"
            columns: ["show_id"]
            isOneToOne: false
            referencedRelation: "shows"
            referencedColumns: ["id"]
          },
        ]
      }
      wa_messages: {
        Row: {
          body: string | null
          created_at: string
          direction: string
          error: string | null
          id: string
          payload: Json
          provider_wamid: string | null
          status: string
          status_at: string | null
          template_name: string | null
          type: string | null
          wa_id: string
          wamid: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          direction: string
          error?: string | null
          id?: string
          payload?: Json
          provider_wamid?: string | null
          status: string
          status_at?: string | null
          template_name?: string | null
          type?: string | null
          wa_id: string
          wamid: string
        }
        Update: {
          body?: string | null
          created_at?: string
          direction?: string
          error?: string | null
          id?: string
          payload?: Json
          provider_wamid?: string | null
          status?: string
          status_at?: string | null
          template_name?: string | null
          type?: string | null
          wa_id?: string
          wamid?: string
        }
        Relationships: []
      }
    }
    Views: {
      production_stage_rollup: {
        Row: {
          assignee_ids: string[] | null
          done: number | null
          in_progress: number | null
          in_progress_stages: Json | null
          production_id: string | null
          total: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stages_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      v_production_review_rounds: {
        Row: {
          first_sent_at: string | null
          last_response_at: string | null
          production_id: string | null
          revision_rounds: number | null
          total_rounds: number | null
        }
        Relationships: [
          {
            foreignKeyName: "client_review_links_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      v_review_media_purge_due: {
        Row: {
          approval_id: string | null
          approved_at: string | null
          item_id: string | null
          latest_ready_at: string | null
          latest_version_id: string | null
          purge_after: string | null
          upload_pending: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "client_review_approvals_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "client_review_items"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      approve_client_registration: {
        Args: {
          p_actor: string
          p_client_name: string
          p_contacts: Json
          p_normalized_name: string
          p_registration_id: string
          p_show: Json
          p_tax_id: string
        }
        Returns: Json
      }
      archive_jobs_for_backfill: {
        Args: never
        Returns: {
          amount: number
          campaign: string
          client_name: string
          external_id: string
          id: string
          job_date: string
        }[]
      }
      assign_review_version_number: {
        Args: { p_version_id: string }
        Returns: number
      }
      assistant_archive_client_revenue: {
        Args: { p_client_id: string }
        Returns: {
          job_count: number
          total: number
        }[]
      }
      attach_client_registration: {
        Args: {
          p_actor: string
          p_contacts: Json
          p_registration_id: string
          p_show: Json
          p_show_id: string
        }
        Returns: Json
      }
      backfill_archive_job_external_id: {
        Args: { p_external_id: string; p_id: string }
        Returns: undefined
      }
      booking_approve_replacing: {
        Args: { p_actor: string; p_new: string; p_now: string; p_old: string }
        Returns: string
      }
      booking_revert_replacing: {
        Args: { p_new: string; p_old: string }
        Returns: string
      }
      can_edit_money: { Args: never; Returns: boolean }
      can_edit_stages: { Args: never; Returns: boolean }
      can_import: { Args: never; Returns: boolean }
      can_manage_users: { Args: never; Returns: boolean }
      can_view_money: { Args: never; Returns: boolean }
      can_view_stages: { Args: never; Returns: boolean }
      create_review_pin: {
        Args: {
          p_after_response: boolean
          p_author_id: string
          p_author_kind: string
          p_author_name: string
          p_body: string
          p_link_id: string
          p_time_ms: number
          p_version_id: string
        }
        Returns: {
          acked_at: string | null
          acked_by: string | null
          after_response: boolean
          author_id: string | null
          author_kind: string
          author_name: string | null
          backfill_source: string | null
          body: string
          created_at: string
          id: string
          is_backfill: boolean
          item_id: string
          kind: string
          link_id: string | null
          pin_number: number | null
          resolved_at: string | null
          resolved_by: string | null
          time_ms: number | null
          version_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "client_review_comments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      due_date_for: {
        Args: {
          base: string
          terms: Database["public"]["Enums"]["payment_terms"]
        }
        Returns: string
      }
      ensure_job_for_production: {
        Args: { p_id: string; p_reason: string }
        Returns: string
      }
      import_archive_ids: {
        Args: { p_ids: string[]; p_kind: string }
        Returns: {
          external_id: string
        }[]
      }
      insert_archive_job: { Args: { p_job: Json }; Returns: string }
      is_approved: { Args: never; Returns: boolean }
      is_owner: { Args: never; Returns: boolean }
      is_owner_strict: { Args: never; Returns: boolean }
      is_studio_admin: { Args: never; Returns: boolean }
      move_jobs_to_archive: { Args: { job_ids: string[] }; Returns: number }
      move_productions_to_archive: {
        Args: { production_ids: string[] }
        Returns: number
      }
      prod_cursor_rank: {
        Args: { s: Database["public"]["Enums"]["production_status"] }
        Returns: number
      }
      production_status_rank: {
        Args: { s: Database["public"]["Enums"]["production_status"] }
        Returns: number
      }
      purge_rejected_registrations: {
        Args: { p_cutoff: string }
        Returns: Json
      }
      reject_client_registration: {
        Args: { p_actor: string; p_reason: string; p_registration_id: string }
        Returns: Json
      }
      review_item_comment: {
        Args: {
          p_body: string
          p_item_id: string
          p_kind: string
          p_link_id: string
          p_time_ms: number
          p_version_id: string
        }
        Returns: Json
      }
      review_item_reapprove: {
        Args: { p_item_id: string; p_link_id: string; p_version_id: string }
        Returns: Json
      }
    }
    Enums: {
      billing_cadence: "per_episode" | "monthly" | "every_n"
      billing_mode: "per_episode" | "retainer" | "package" | "none"
      invoice_source: "morning_api" | "manual"
      invoice_type: "עסקה" | "מס"
      misc_production_status: "נפתח" | "בעבודה" | "הושלם" | "בוטל"
      paid_status: "כן" | "לא" | "ללא חיוב" | "לא ידוע"
      payment_terms:
        | "immediate"
        | "net_30"
        | "net_60"
        | "eom_30"
        | "eom_60"
        | "eom_90"
      pending_doc_status:
        | "pending"
        | "approved"
        | "rejected"
        | "issued"
        | "failed"
        | "cancelled"
        | "accrued"
        | "consolidated"
      pending_doc_type:
        | "work_order"
        | "deal_invoice"
        | "tax_invoice"
        | "tax_receipt"
        | "receipt"
      production_kind: "client" | "internal" | "contract"
      production_status:
        | "עתיד_להתחיל"
        | "בהקלטה"
        | "הוקלט"
        | "בעריכה"
        | "נערך"
        | "נשלח_ללקוח"
        | "ממתין_לתגובת_לקוח"
        | 'אושר_ע"י_לקוח'
        | "הופץ"
        | "בוטל"
      show_billing_mode: "per_episode" | "contract" | "none"
      show_pricing_model: "per_episode" | "per_hour"
      stage_status: "pending" | "in_progress" | "done"
      stage_step: "record" | "edit" | "deliver"
      stage_track: "episode" | "reels"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      billing_cadence: ["per_episode", "monthly", "every_n"],
      billing_mode: ["per_episode", "retainer", "package", "none"],
      invoice_source: ["morning_api", "manual"],
      invoice_type: ["עסקה", "מס"],
      misc_production_status: ["נפתח", "בעבודה", "הושלם", "בוטל"],
      paid_status: ["כן", "לא", "ללא חיוב", "לא ידוע"],
      payment_terms: [
        "immediate",
        "net_30",
        "net_60",
        "eom_30",
        "eom_60",
        "eom_90",
      ],
      pending_doc_status: [
        "pending",
        "approved",
        "rejected",
        "issued",
        "failed",
        "cancelled",
        "accrued",
        "consolidated",
      ],
      pending_doc_type: [
        "work_order",
        "deal_invoice",
        "tax_invoice",
        "tax_receipt",
        "receipt",
      ],
      production_kind: ["client", "internal", "contract"],
      production_status: [
        "עתיד_להתחיל",
        "בהקלטה",
        "הוקלט",
        "בעריכה",
        "נערך",
        "נשלח_ללקוח",
        "ממתין_לתגובת_לקוח",
        'אושר_ע"י_לקוח',
        "הופץ",
        "בוטל",
      ],
      show_billing_mode: ["per_episode", "contract", "none"],
      show_pricing_model: ["per_episode", "per_hour"],
      stage_status: ["pending", "in_progress", "done"],
      stage_step: ["record", "edit", "deliver"],
      stage_track: ["episode", "reels"],
    },
  },
} as const
