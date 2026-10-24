import { Router } from 'express';
import * as ctrl from '../controllers/media.controller.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { projectAccess } from '../middleware/projectAccess.js';
import { uploadLimiter } from '../middleware/rateLimiter.js';
import { ROLES } from '../config/constants.js';
import {
  uploadSignatureSchema,
  registerMediaSchema,
  updateMediaSchema,
  deleteMediaSchema,
  mediaIdSchema,
  listMediaSchema,
} from '../validators/media.validator.js';

const router = Router();
router.use(authenticate);

const { SUPER_ADMIN, ENGINEER, CUSTOMER } = ROLES;

// Uploading: admin or an assigned engineer
const uploaders = projectAccess({ from: 'body', roles: [SUPER_ADMIN, ENGINEER] });
// Browsing a project gallery: workers are not included. Customers get filtered results.
const galleryReaders = projectAccess({ from: 'query', roles: [SUPER_ADMIN, ENGINEER, CUSTOMER] });

// Step 1: the app asks for a signature. Step 2: it uploads to Cloudinary. Step 3: it registers the file.
router.post('/upload-signature', uploadLimiter, validate(uploadSignatureSchema), uploaders, ctrl.getUploadSignature);
router.post('/', uploadLimiter, validate(registerMediaSchema), uploaders, ctrl.registerMedia);

router.get('/', validate(listMediaSchema), galleryReaders, ctrl.listMedia);

// Routes with :mediaId. The controller checks project access and customer visibility itself.
router.get('/:mediaId', validate(mediaIdSchema), ctrl.getMedia);
router.patch('/:mediaId', validate(updateMediaSchema), ctrl.updateMedia);
// DELETE carries a JSON body with the reason
router.delete('/:mediaId', validate(deleteMediaSchema), ctrl.deleteMedia);

export default router;