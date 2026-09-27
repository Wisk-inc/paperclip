import type {
  CompanyDevice,
  CompanyDeviceWithIndex,
  CreateDeviceFileRequestRequest,
  DeclineDeviceFileRequestRequest,
  DeviceFile,
  DeviceFileRequest,
  DeviceFileRequestStatus,
  DeviceFilesOverview,
  RegisterCompanyDeviceRequest,
  ReportDeviceSharedIndexRequest,
  UpdateCompanyDeviceRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export interface DeviceHeartbeatResult {
  device: CompanyDevice;
  pendingRequests: DeviceFileRequest[];
}

export interface DeviceFileRequestDetail extends DeviceFileRequest {
  file: DeviceFile | null;
}

export interface UploadDeviceFileInput {
  file: Blob;
  filename: string;
  sourceDeviceId?: string | null;
  targetDeviceId?: string | null;
  issueId?: string | null;
  note?: string | null;
  devicePath?: string | null;
}

export interface FulfillDeviceFileRequestInput {
  file: Blob;
  filename: string;
  deviceId?: string | null;
  note?: string | null;
  devicePath?: string | null;
}

function appendOptional(form: FormData, key: string, value: string | null | undefined) {
  if (value) form.append(key, value);
}

const company = (companyId: string) => `/companies/${encodeURIComponent(companyId)}`;

export const deviceFilesApi = {
  overview: (companyId: string) =>
    api.get<DeviceFilesOverview>(`${company(companyId)}/device-files/overview`),
  listDevices: (companyId: string) =>
    api.get<CompanyDevice[]>(`${company(companyId)}/devices`),
  getDevice: (deviceId: string) =>
    api.get<CompanyDeviceWithIndex>(`/devices/${encodeURIComponent(deviceId)}`),
  registerDevice: (companyId: string, payload: RegisterCompanyDeviceRequest) =>
    api.post<CompanyDevice>(`${company(companyId)}/devices`, payload),
  updateDevice: (deviceId: string, payload: UpdateCompanyDeviceRequest) =>
    api.patch<CompanyDevice>(`/devices/${encodeURIComponent(deviceId)}`, payload),
  heartbeat: (deviceId: string) =>
    api.post<DeviceHeartbeatResult>(`/devices/${encodeURIComponent(deviceId)}/heartbeat`, {}),
  reportSharedIndex: (deviceId: string, payload: ReportDeviceSharedIndexRequest) =>
    api.put<CompanyDevice>(`/devices/${encodeURIComponent(deviceId)}/shared-index`, payload),
  removeDevice: (deviceId: string) =>
    api.delete<CompanyDevice>(`/devices/${encodeURIComponent(deviceId)}`),

  listFiles: (companyId: string, filters: { sourceDeviceId?: string; targetDeviceId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.sourceDeviceId) params.set("sourceDeviceId", filters.sourceDeviceId);
    if (filters.targetDeviceId) params.set("targetDeviceId", filters.targetDeviceId);
    const query = params.toString();
    return api.get<DeviceFile[]>(`${company(companyId)}/device-files${query ? `?${query}` : ""}`);
  },
  uploadFile: (companyId: string, input: UploadDeviceFileInput) => {
    const form = new FormData();
    form.append("file", input.file, input.filename);
    appendOptional(form, "sourceDeviceId", input.sourceDeviceId);
    appendOptional(form, "targetDeviceId", input.targetDeviceId);
    appendOptional(form, "issueId", input.issueId);
    appendOptional(form, "note", input.note);
    appendOptional(form, "devicePath", input.devicePath);
    return api.postForm<DeviceFile>(`${company(companyId)}/device-files`, form);
  },
  deleteFile: (fileId: string) =>
    api.delete<{ ok: true; id: string }>(`/device-files/${encodeURIComponent(fileId)}`),
  contentUrl: (fileId: string, options: { download?: boolean } = {}) =>
    `/api/device-files/${encodeURIComponent(fileId)}/content${options.download ? "?download=1" : ""}`,

  listRequests: (companyId: string, filters: { status?: DeviceFileRequestStatus; deviceId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.deviceId) params.set("deviceId", filters.deviceId);
    const query = params.toString();
    return api.get<DeviceFileRequest[]>(`${company(companyId)}/device-file-requests${query ? `?${query}` : ""}`);
  },
  getRequest: (requestId: string) =>
    api.get<DeviceFileRequestDetail>(`/device-file-requests/${encodeURIComponent(requestId)}`),
  createRequest: (companyId: string, payload: CreateDeviceFileRequestRequest) =>
    api.post<DeviceFileRequest>(`${company(companyId)}/device-file-requests`, payload),
  fulfillRequest: (requestId: string, input: FulfillDeviceFileRequestInput) => {
    const form = new FormData();
    form.append("file", input.file, input.filename);
    appendOptional(form, "deviceId", input.deviceId);
    appendOptional(form, "note", input.note);
    appendOptional(form, "devicePath", input.devicePath);
    return api.postForm<DeviceFileRequestDetail>(
      `/device-file-requests/${encodeURIComponent(requestId)}/fulfill`,
      form,
    );
  },
  declineRequest: (requestId: string, payload: DeclineDeviceFileRequestRequest = {}) =>
    api.post<DeviceFileRequest>(`/device-file-requests/${encodeURIComponent(requestId)}/decline`, payload),
  cancelRequest: (requestId: string) =>
    api.post<DeviceFileRequest>(`/device-file-requests/${encodeURIComponent(requestId)}/cancel`, {}),
};
