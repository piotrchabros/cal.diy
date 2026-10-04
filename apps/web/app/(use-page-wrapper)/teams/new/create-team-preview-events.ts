import { Bell, Clock, MapPin, MessageCircle, Video } from "lucide-react";

export const CREATE_TEAM_PREVIEW_EVENTS = [
  {
    key: "demo",
    icon: Bell,
    titleKey: "create_team_preview_demo_title",
    descriptionKey: "create_team_preview_demo_description",
    durationKey: "create_team_preview_15_mins",
  },
  {
    key: "quick",
    icon: Video,
    titleKey: "create_team_preview_quick_title",
    descriptionKey: "create_team_preview_quick_description",
    durationKey: "create_team_preview_15_mins",
  },
  {
    key: "longer",
    icon: Clock,
    titleKey: "create_team_preview_longer_title",
    descriptionKey: "create_team_preview_longer_description",
    durationKey: "create_team_preview_30_mins",
  },
  {
    key: "in-person",
    icon: MapPin,
    titleKey: "create_team_preview_in_person_title",
    descriptionKey: "create_team_preview_in_person_description",
    durationKey: "create_team_preview_120_mins",
  },
  {
    key: "question",
    icon: MessageCircle,
    titleKey: "create_team_preview_question_title",
    descriptionKey: "create_team_preview_question_description",
    durationKey: "create_team_preview_15_mins",
  },
] as const;
