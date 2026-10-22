import { type Container, createModule, type ModuleLoader } from "@calcom/features/di/di";
import type { INotetakerPdfRenderer } from "../lib/export/INotetakerPdfRenderer";
import { PdfmakeNotetakerPdfRenderer } from "../lib/export/PdfmakeNotetakerPdfRenderer";
import { NOTETAKER_DI_TOKENS } from "./tokens";

const thisModule = createModule();
const token = NOTETAKER_DI_TOKENS.NOTETAKER_PDF_RENDERER;
const moduleToken = NOTETAKER_DI_TOKENS.NOTETAKER_PDF_RENDERER_MODULE;

// No dependencies, so bindModuleToClassOnToken does not apply. Singleton so the loaded fonts are reused.
thisModule.bind(token).toFactory((): INotetakerPdfRenderer => new PdfmakeNotetakerPdfRenderer(), "singleton");

const loadModule = (container: Container): void => {
  container.load(moduleToken, thisModule);
};

export const moduleLoader = {
  token,
  loadModule,
} satisfies ModuleLoader;
