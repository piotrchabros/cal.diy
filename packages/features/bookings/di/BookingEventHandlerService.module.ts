import {
  BookingEventHandlerService,
  type NotetakerChoiceServiceAccessor,
} from "@calcom/features/bookings/lib/onBookingEvents/BookingEventHandlerService";
import { bindModuleToClassOnToken, createModule, type ModuleLoader } from "@calcom/features/di/di";
import { moduleLoader as loggerModuleLoader } from "@calcom/features/di/shared/services/logger.service";
import { DI_TOKENS } from "@calcom/features/di/tokens";
import { moduleLoader as hashedLinkServiceModuleLoader } from "@calcom/features/hashedLink/di/HashedLinkService.module";

const thisModule = createModule();
const token = DI_TOKENS.BOOKING_EVENT_HANDLER_SERVICE;
const moduleToken = DI_TOKENS.BOOKING_EVENT_HANDLER_SERVICE_MODULE;

// Local token: the accessor is private to this module, so it does not belong in the shared token maps.
const notetakerChoiceServiceAccessorToken = Symbol("BookingEventHandlerNotetakerChoiceServiceAccessor");

// Dynamic import so that resolving the booking event handler never loads or resolves the notetaker
// graph; an invalid NOTETAKER_* variable then surfaces inside the handler's try/catch, not at booking time.
const getNotetakerChoiceService: NotetakerChoiceServiceAccessor = async () => {
  const { getNotetakerChoiceService: getService } = await import(
    "@calcom/features/notetaker/di/NotetakerChoiceService.container"
  );
  return getService();
};
thisModule.bind(notetakerChoiceServiceAccessorToken).toFunction(getNotetakerChoiceService);

const notetakerChoiceServiceAccessorModuleLoader = {
  token: notetakerChoiceServiceAccessorToken,
  loadModule: (container) => {
    container.load(moduleToken, thisModule);
  },
} satisfies ModuleLoader;

const loadModule = bindModuleToClassOnToken({
  module: thisModule,
  moduleToken,
  token,
  classs: BookingEventHandlerService,
  depsMap: {
    hashedLinkService: hashedLinkServiceModuleLoader,
    log: loggerModuleLoader,
    getNotetakerChoiceService: notetakerChoiceServiceAccessorModuleLoader,
  },
});

export const moduleLoader = {
  token,
  loadModule,
};

export type { BookingEventHandlerService };
