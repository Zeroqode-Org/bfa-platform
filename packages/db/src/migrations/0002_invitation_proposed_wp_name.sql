ALTER TABLE "invitations" ADD COLUMN "proposed_water_purveyor_name" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_new_wp_name_shape" CHECK ((
				"invitations"."associated_wp_id" is null
				and "invitations"."role" = 'wp_admin'
				and "invitations"."proposed_water_purveyor_name" is not null
				and length(btrim("invitations"."proposed_water_purveyor_name")) > 0
			) or (
				"invitations"."associated_wp_id" is not null
				and "invitations"."proposed_water_purveyor_name" is null
			));